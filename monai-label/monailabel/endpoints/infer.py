# Copyright (c) MONAI Consortium
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import json
import logging
import os
import pathlib
import shutil
import tempfile
from enum import Enum
from datetime import date
from typing import Optional
from glob import glob as glob
import json
import io
from copy import deepcopy

import SimpleITK as sitk
import numpy as np
from highdicom.seg import Segmentation
from highdicom.seg.content import SegmentDescription
from highdicom.sr.content import SourceImageForSegmentation
from highdicom.content import AlgorithmIdentificationSequence

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.background import BackgroundTasks
from fastapi.responses import FileResponse, Response
from requests_toolbelt import MultipartEncoder

import pydicom
from pydicom.filereader import dcmread
from pydicom.sr.codedict import codes
from pydicom.uid import generate_uid


from monailabel.config import RBAC_USER, settings
from monailabel.datastore.dicom import DICOMWebDatastore
from monailabel.datastore.utils.convert import binary_to_image, nifti_to_dicom_seg, itk_image_to_dicom_seg
from monailabel.endpoints.user.auth import RBAC, User
from monailabel.interfaces.app import MONAILabelApp
from monailabel.interfaces.utils.app import app_instance
from monailabel.utils.others.generic import get_mime_type, remove_file

from monailabel.datastore.utils.dicom import dicom_web_upload_dcm

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/infer",
    tags=["Infer"],
    responses={
        404: {"description": "Not found"},
        200: {
            "description": "OK",
            "content": {
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "properties": {
                            "points": {
                                "type": "string",
                                "description": "Reserved for future; Currently it will be empty",
                            },
                            "file": {
                                "type": "string",
                                "format": "binary",
                                "description": "The result NIFTI image which will have segmentation mask",
                            },
                        },
                    },
                    "encoding": {
                        "points": {"contentType": "text/plain"},
                        "file": {"contentType": "application/octet-stream"},
                    },
                },
                "application/json": {"schema": {"type": "string", "example": "{}"}},
                "application/octet-stream": {"schema": {"type": "string", "format": "binary"}},
                "application/dicom": {"schema": {"type": "string", "format": "binary"}},
            },
        },
    },
)


class ResultType(str, Enum):
    image = "image"
    json = "json"
    all = "all"
    dicom_seg = "dicom_seg"


def send_response(datastore, result, output, background_tasks):
    res_img = result.get("file") if result.get("file") else result.get("label")
    res_tag = result.get("tag")
    res_json = result.get("params")

    if res_img:
        if not os.path.exists(res_img):
            res_img = datastore.get_label_uri(res_img, res_tag)
        else:
            background_tasks.add_task(remove_file, res_img)

    if output == "json":
        return res_json

    m_type = get_mime_type(res_img)

    if output == "image":
        return FileResponse(res_img, media_type=m_type, filename=os.path.basename(res_img))

    if output == "dicom_seg":
        res_dicom_seg = result.get("dicom_seg")
        if res_dicom_seg is None:
            logger.info("No dicom_seg?")
            raise HTTPException(status_code=500, detail="Error processing inference")
        else:
            logger.info("File response!")
            return Response(content=res_dicom_seg, media_type="application/json")
            #return FileResponse(res_dicom_seg, media_type="application/dicom", filename=os.path.basename(res_dicom_seg))

    res_fields = dict()
    res_fields["params"] = (None, json.dumps(res_json), "application/json")
    if res_img and os.path.exists(res_img):
        res_fields["image"] = (os.path.basename(res_img), open(res_img, "rb"), m_type)
    else:
        logger.info(f"Return only Result Json as Result Image is not available: {res_img}")
        return res_json

    return_message = MultipartEncoder(fields=res_fields)
    return Response(content=return_message.to_string(), media_type=return_message.content_type)


def run_inference(
    background_tasks: BackgroundTasks,
    model: str,
    image: str = "",
    session_id: str = "",
    params: str = Form("{}"),
    file: UploadFile = File(None),
    label: UploadFile = File(None),
    output: Optional[ResultType] = None,
):
    request = {"model": model, "image": image}

    if not file and not image and not session_id:
        raise HTTPException(status_code=500, detail="Neither Image nor File not Session ID input is provided")

    instance: MONAILabelApp = app_instance()

    if file:
        file_ext = "".join(pathlib.Path(file.filename).suffixes) if file.filename else ".nii.gz"
        image_file = tempfile.NamedTemporaryFile(suffix=file_ext).name

        with open(image_file, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            request["image"] = image_file
            background_tasks.add_task(remove_file, image_file)

    if label:
        file_ext = "".join(pathlib.Path(label.filename).suffixes) if label.filename else ".nii.gz"
        label_file = tempfile.NamedTemporaryFile(suffix=file_ext).name

        with open(label_file, "wb") as buffer:
            shutil.copyfileobj(label.file, buffer)
            background_tasks.add_task(remove_file, label_file)

        # if binary file received, e.g. scribbles from OHIF - then convert using reference image
        if file_ext == ".bin":
            image_uri = instance.datastore().get_image_uri(image)
            label_file = binary_to_image(image_uri, label_file)

        request["label"] = label_file

    config = instance.info().get("config", {}).get("infer", {})
    request.update(config)

    p = json.loads(params) if params else {}
    request.update(p)

    if session_id:
        session = instance.sessions().get_session(session_id)
        if session:
            request["image"] = session.image
            request["session"] = session.to_json()

    logger.info(f"Infer Request: {request}")
    result = instance.infer(request)
    if result is None:
        raise HTTPException(status_code=500, detail="Failed to execute infer")

    # Dicom Seg Integration
    if output == "dicom_seg":
        dicom_seg_file = None
        if not isinstance(instance.datastore(), DICOMWebDatastore):
            raise HTTPException(status_code=500, detail="DICOM SEG format is not supported in a non-DICOM datastore")
        #elif p.get("label_info") is None:
        #    raise HTTPException(status_code=404, detail="Parameters for DICOM SEG inference cannot be empty!")
        # Transform image uri to id (similar to _to_id in local datastore)
        image_uri = instance.datastore().get_image_uri(image)
        suffixes = [".nii", ".nii.gz", ".nrrd"]
        image_path = [image_uri.replace(suffix, "") for suffix in suffixes if image_uri.endswith(suffix)][0]
        res_img = result.get("file") if result.get("file") else result.get("label")
        
        image_files = glob('{}/*'.format(image_path))
        dcm_img_sample = dcmread(image_files[0], stop_before_pixels=True)
        if 0x0008103e in dcm_img_sample.keys():
            image_series_desc = dcm_img_sample[0x0008103e].value
        image_series_desc = "SAM2_"+ image_series_desc
        existing_instances = instance.datastore()._client.search_for_series(search_filters={"SeriesDate": date.today().strftime("%Y%m%d"), "SeriesDescription": image_series_desc})
        old_response = 0
        if len(existing_instances)>0:
            res = instance.datastore()._client._http_post("http://ohif_orthanc:1026/pacs/tools/find",'{{"Level":"Series","Query":{{"SeriesInstanceUID":"{seriesID}"}}, "Expand":true}}'.format(seriesID=existing_instances[0]['0020000E']['Value'][0]), headers={'Content-Type': 'text/plain'})
            if res.status_code == 200:
                del_series_id = json.loads(res.content)[0]['ID']
                del_instance_id = json.loads(res.content)[0]['Instances'][0]
                if 'nextObj' in params:
                    old_response = instance.datastore()._client._http_get(f"http://ohif_orthanc:1026/pacs/instances/{del_instance_id}/file")
                    if old_response.status_code == 200:
                        # Load DICOM data from the binary response content
                        dicom_old_file = io.BytesIO(old_response.content)
                    else:
                        raise Exception(f"Failed to retrieve DICOM file: {old_response.status_code}")    
                res_del = instance.datastore()._client._http_delete(f"http://ohif_orthanc:1026/pacs/series/{del_series_id}")
                if res_del.status_code != 200:
                    breakpoint()
        dicom_seg_file = nifti_to_dicom_seg(image_path, res_img, p.get("label_info"), use_itk=True)
        
        if old_response != 0:
            dicom_seg1 = pydicom.dcmread(dicom_old_file)
            seg_array1 = dicom_seg1.pixel_array
            dicom_seg2 = pydicom.dcmread(dicom_seg_file)
            seg_array2 = dicom_seg2.pixel_array

            segmentations = [dicom_seg1, dicom_seg2]
            #img = sitk.ReadImage(image_uri) 
            #image_datasets = [dcmread(str(f), stop_before_pixels=True) for f in image_files]

            # Read the first segmentation file
            segment_arrays_1, segment_frames_1, metadata_source = read_seg_file(dicom_seg1)
            logger.info(f"Seg1 array shape: {np.array(segment_arrays_1).shape}")
            #combined_pixel_array = np.concatenate(segment_arrays_1, axis=0)
            # Read the second segmentation file
            segment_arrays_2, segment_frames_2, _ = read_seg_file(dicom_seg2)
            logger.info(f"Seg2 array shape: {np.array(segment_arrays_2).shape}")
            combined_pixel_array = np.concatenate((segment_arrays_1, segment_arrays_2), axis=0)
            logger.info(f"combined array shape: {combined_pixel_array.shape}")
            
            segment_sequence_1 = dicom_seg1.SegmentSequence
            segment_sequence_2 = dicom_seg2.SegmentSequence
            # Merge segment sequences and adjust SegmentNumber
            current_max_label = len(segment_sequence_1)
            for i, segment in enumerate(segment_sequence_2):
                segment.SegmentNumber = current_max_label + i + 1
                segment_sequence_1.append(segment_sequence_2[i])

            all_segments = segment_sequence_1
            updated_frames_2 = [(segment_index + current_max_label, slice_index, sop_instance_uid) for segment_index, slice_index, sop_instance_uid in segment_frames_2]
            combined_frames = segment_frames_1 + updated_frames_2


            # Save the combined segmentation
            combined_segmentation = save_combined_segmentation(
                combined_pixel_array, all_segments, combined_frames, metadata_source
            )

            #logger.info(f"{seg_array1.shape} => seg_array1")
            #logger.info(f"{seg_array2.shape} => seg_array2")
        #
            ## Prepare a combined array with unique labels for each segmentation
            #combined_pixel_array = np.zeros_like(segmentations[0].pixel_array)
            #label_offset = 1
            #segment_offset = 0
            #combined_segment_sequence = []
            #merged_per_frame_sequence = segmentations[0].PerFrameFunctionalGroupsSequence
#
            #for seg_idx, seg in enumerate(segmentations):
            #    # Combine pixel data
            #    for label in np.unique(seg.pixel_array):
            #        if label > 0:
            #            logger.info(f"{label} in combined added")
            #            logger.info(f"{seg_idx} in seg_idx_result_added")
            #            combined_pixel_array[seg.pixel_array == label] = label_offset
            #            label_offset += 1
#
            #    # Combine SegmentSequence
            #    for segment in seg.SegmentSequence:
            #        new_segment = segment.copy()
            #        new_segment.SegmentNumber += segment_offset
            #        combined_segment_sequence.append(new_segment)
            #    
            #    segment_offset += len(seg.SegmentSequence)
            #    # Combine PerFrameFunctionalGroupsSequence
            #for frame_idx in range(combined_pixel_array.shape[0]):
            #    merged_per_frame_sequence[frame_idx].SegmentIdentificationSequence[0].ReferencedSegmentNumber = [x+1 for x in list(range(len(combined_segment_sequence)))]
                

            #itk_image = sitk.GetImageFromArray(combined_seg_array)
            #itk_image.CopyInformation(img)
#
            #unique_labels = np.unique(combined_seg_array.flatten()).astype(np.int_)
            #unique_labels = unique_labels[unique_labels != 0]
#
            #label_names = "sam_label"
        #
            #segment_attributes = []
#
            #for i, idx in enumerate(unique_labels):
            #    info = {}
            #    name = label_names
            #    description = info.get("description", "Unknown")
            #    rgb = list(np.random.random(size=3) * 256)
            #    rgb = [int(x) for x in rgb]
#
            #    logger.info(f"{i} => {idx} => {name}")
#
            #    segment_attribute = info.get(
            #        "segmentAttribute",
            #        {
            #            "labelID": int(idx),
            #            "SegmentLabel": name,
            #            "SegmentDescription": description,
            #            "SegmentAlgorithmType": "AUTOMATIC",
            #            "SegmentAlgorithmName": "MONAILABEL",
            #            "SegmentedPropertyCategoryCodeSequence": {
            #                "CodeValue": "123037004",
            #                "CodingSchemeDesignator": "SCT",
            #                "CodeMeaning": "Anatomical Structure",
            #            },
            #            "SegmentedPropertyTypeCodeSequence": {
            #                "CodeValue": "78961009",
            #                "CodingSchemeDesignator": "SCT",
            #                "CodeMeaning": name,
            #            },
            #            "recommendedDisplayRGBValue": rgb,
            #        },
            #    )
            #    segment_attributes.append(segment_attribute)
#
            #template = {
            #    "ContentCreatorName": "Reader1",
            #    "ClinicalTrialSeriesID": "Session1",
            #    "ClinicalTrialTimePointID": "1",
            #    "SeriesDescription": image_series_desc,
            #    "SeriesNumber": "300",
            #    "InstanceNumber": "1",
            #    "segmentAttributes": [segment_attributes],
            #    "ContentLabel": "SEGMENTATION",
            #    "ContentDescription": "MONAI Label - Image segmentation",
            #    "ClinicalTrialCoordinatingCenterName": "MONAI",
            #    "BodyPartExamined": "",
            #}
            # Create new DICOM-SEG (using the first as a template)
            # logger.info(f"{np.unique(combined_pixel_array)} in array")
            # combined_segmentation = segmentations[0]
            # combined_segmentation.BitsAllocated = 8
            # combined_segmentation.BitsStored = 8
            # combined_segmentation.HighBit = 7
            # combined_segmentation.PixelRepresentation = 0 
            # combined_segmentation.PixelData = combined_pixel_array.astype(np.uint8).tobytes()
            # combined_segmentation.NumberOfFrames = combined_pixel_array.shape[0]
            # combined_segmentation.SegmentSequence = combined_segment_sequence
            # combined_segmentation.PerFrameFunctionalGroupsSequence = merged_per_frame_sequence
         
            #dicom_seg_file = itk_image_to_dicom_seg(itk_image, image_path, template)
            # Save the combined segmentation
            combined_segmentation.save_as(dicom_seg_file)


        series_id = dicom_web_upload_dcm(dicom_seg_file, instance.datastore()._client)
        result["dicom_seg"] = series_id

    return send_response(instance.datastore(), result, output, background_tasks)

def read_seg_file(seg):
    """
    Reads a DICOM-SEG file and extracts the pixel array and segment metadata.
    """
    num_frames = seg.NumberOfFrames
    rows = seg.Rows
    columns = seg.Columns
    num_segments = len(seg.SegmentSequence)

    # Unpack PixelData
    pixel_array = np.unpackbits(np.frombuffer(seg.PixelData, dtype=np.uint8)).reshape(num_frames, rows, columns)

    # Get the SOPInstanceUIDs from ReferencedSeriesSequence
    referenced_instance_uids = [
        item.ReferencedSOPInstanceUID
        for item in seg.ReferencedSeriesSequence[0].ReferencedInstanceSequence
    ]
    # Reorganize pixel array by segment
    frames_per_segment = num_frames // num_segments

    # Filter out empty frames for each segment
    reduced_pixel_array = []
    filtered_frames = []
    total_frame_count=0
    for i in range(num_segments):
        # Extract frames for the current segment
        segment_frames = pixel_array[i * frames_per_segment:(i + 1) * frames_per_segment]
        
        for slice_index, frame in enumerate(segment_frames):
            if np.any(frame > 0):
                reduced_pixel_array.append(frame)
                if len(segment_frames) == len(referenced_instance_uids):
                    filtered_frames.append((i + 1, len(segment_frames)-slice_index, referenced_instance_uids[slice_index]))  # 1-based indexing
                else:
                    logger.info(f"Segment {i}, Slice index: {slice_index}")
                    logger.info(f"Segment {i}, total_frame_count: {total_frame_count}")
                    filtered_frames.append((i + 1, len(segment_frames)-slice_index, seg.PerFrameFunctionalGroupsSequence[total_frame_count].DerivationImageSequence[0].SourceImageSequence[0].ReferencedSOPInstanceUID))
                total_frame_count+=1
    reduced_pixel_array = np.stack(reduced_pixel_array)
    return reduced_pixel_array, filtered_frames, seg


def save_combined_segmentation(combined_pixel_array, all_segments, combined_frames, metadata_source):
    """
    Saves the combined segmentation as a new DICOM-SEG file by reusing metadata from existing files.
    """
    # Reuse metadata from the source
    combined_segmentation = metadata_source

    # Update metadata for combined segmentation
    combined_segmentation.NumberOfFrames = combined_pixel_array.shape[0]
    combined_segmentation.SegmentSequence = all_segments
    combined_segmentation.SeriesInstanceUID = generate_uid()
    
    #combined_segmentation.Rows = combined_pixel_array.shape[1]
    #combined_segmentation.Columns = combined_pixel_array.shape[2]
    #combined_segmentation.ContentDate = datetime.now().strftime("%Y%m%d")
    #combined_segmentation.ContentTime = datetime.now().strftime("%H%M%S")

    # Update PerFrameFunctionalGroupsSequence
    # Update PerFrameFunctionalGroupsSequence
    new_per_frame_sequence = []
    for segment_index, slice_index, sop_instance_uid in combined_frames:
        frame = deepcopy(combined_segmentation.PerFrameFunctionalGroupsSequence[0])
        frame.FrameContentSequence[0].DimensionIndexValues = [segment_index, slice_index]
        frame.SegmentIdentificationSequence[0].ReferencedSegmentNumber = segment_index
        # Update ReferencedSOPInstanceUID in DerivationImageSequence
        frame.DerivationImageSequence[0].SourceImageSequence[0].ReferencedSOPInstanceUID = sop_instance_uid
        new_per_frame_sequence.append(frame)
    #per_frame_sequence = []
    #num_segments = len(all_segments)
    #frames_per_segment = combined_pixel_array.shape[0] // num_segments
    #for i, segment in enumerate(all_segments):
    #    for frame_index in range(frames_per_segment):
    #        frame = deepcopy(combined_segmentation.PerFrameFunctionalGroupsSequence[0])
    #        frame.FrameContentSequence[0].DimensionIndexValues = [i + 1, frame_index + 1]
    #        frame.SegmentIdentificationSequence[0].ReferencedSegmentNumber = i + 1
    #        logger.info(f"segment{i}_{frame_index} Just before adding frame")
    #        per_frame_sequence.append(frame)
    combined_segmentation.PerFrameFunctionalGroupsSequence = new_per_frame_sequence

    # Pack the combined binary pixel array
    packed_pixel_data = np.packbits(combined_pixel_array.astype(np.uint8), axis=-1)
    combined_segmentation.PixelData = packed_pixel_data.tobytes()
    return combined_segmentation
    # Save the combined segmentation
    #combined_segmentation.save_as(output_path)
    #print(f"Combined segmentation saved to {output_path}")


@router.post("/{model}", summary=f"{RBAC_USER}Run Inference for supported model")
async def api_run_inference(
    background_tasks: BackgroundTasks,
    model: str,
    image: str = "",
    session_id: str = "",
    params: str = Form("{}"),
    file: UploadFile = File(None),
    label: UploadFile = File(None),
    output: Optional[ResultType] = None,
    user: User = Depends(RBAC(settings.MONAI_LABEL_AUTH_ROLE_USER)),
):
    return run_inference(background_tasks, model, image, session_id, params, file, label, output)
