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
import tempfile
import time

import numpy as np
import pydicom
import pydicom_seg
from pydicom import config

import SimpleITK

from monai.transforms import LoadImage
from pydicom.filereader import dcmread

from monailabel.datastore.utils.colors import GENERIC_ANATOMY_COLORS
from monailabel.transform.writer import write_itk
from monailabel.utils.others.generic import run_command

logger = logging.getLogger(__name__)


def extract_frame_pixel_data(ds, frame_num):
    """
    Extract pixel data for a specific frame, handling both compressed and uncompressed data.
    
    Args:
        ds: DICOM dataset
        frame_num: Frame number (0-based)
    
    Returns:
        bytes: Pixel data for the specific frame
    """
    try:
        # First try to get pixel_array which handles compression automatically
        pixel_array = ds.pixel_array
        logger.debug(f"Full pixel array shape: {pixel_array.shape}, dtype: {pixel_array.dtype}")
        
        # Get expected dimensions
        expected_rows = ds.Rows
        expected_cols = ds.Columns
        expected_samples = getattr(ds, 'SamplesPerPixel', 1)
        expected_frames = getattr(ds, 'NumberOfFrames', 1)
        
        logger.debug(f"Expected dimensions: {expected_frames} frames, {expected_rows}x{expected_cols}, {expected_samples} samples/pixel")
        
        # Validate frame count
        actual_frames = 1
        if len(pixel_array.shape) == 4:  # (frames, height, width, channels)
            actual_frames = pixel_array.shape[0]
        elif len(pixel_array.shape) == 3:
            if pixel_array.shape[2] == expected_samples:  # (height, width, channels)
                actual_frames = 1
            else:  # (frames, height, width)
                actual_frames = pixel_array.shape[0]
                
        if actual_frames != expected_frames:
            logger.warning(f"Frame count mismatch: header claims {expected_frames} frames but found {actual_frames} frames")
            if actual_frames == 1 and expected_frames > 1:
                logger.warning("This appears to be a single-frame image incorrectly marked as multi-frame")
                if frame_num > 0:
                    return None
        
        # Extract frame data based on array format
        if len(pixel_array.shape) == 4:  # (frames, height, width, channels)
            if frame_num >= pixel_array.shape[0]:
                return None
            frame_data = pixel_array[frame_num]
        elif len(pixel_array.shape) == 3:
            if pixel_array.shape[2] == expected_samples:  # Single frame (height, width, channels)
                if frame_num > 0:
                    return None
                frame_data = pixel_array
            else:  # Multiple frames (frames, height, width)
                if frame_num >= pixel_array.shape[0]:
                    return None
                frame_data = pixel_array[frame_num]
        else:  # 2D image (height, width)
            if frame_num > 0:
                return None
            frame_data = pixel_array
            
        # Convert to bytes
        return frame_data.tobytes()
        
    except Exception as e:
        logger.error(f"Failed to extract frame {frame_num}: {e}")
        return None


def preserve_ultrasound_metadata(single_frame_ds, original_ds, frame_num):
    """
    Preserve ultrasound-specific metadata when converting to single frame.
    
    Args:
        single_frame_ds: Single frame DICOM dataset
        original_ds: Original multiframe DICOM dataset
        frame_num: Frame number (0-based)
    """
    # Ultrasound-specific tags to preserve
    ultrasound_tags = [
        'SequenceOfUltrasoundRegions',
        'RegionSpatialFormat',
        'RegionDataType',
        'RegionFlags',
        'RegionLocationMinX0',
        'RegionLocationMinY0',
        'RegionLocationMaxX1',
        'RegionLocationMaxY1',
        'ReferencePixelX0',
        'ReferencePixelY0',
        'PhysicalUnitsXDirection',
        'PhysicalUnitsYDirection',
        'PhysicalDeltaX',
        'PhysicalDeltaY',
        'UltrasoundColorDataPresent',
        'TriggerTime',
        'NominalInterval',
        'BeatRejectionFlag',
        'PVCRejection',
        'SkipBeats',
        'HeartRate',
        'CardiacNumberOfImages',
    ]
    
    # Copy ultrasound-specific attributes
    for tag in ultrasound_tags:
        if hasattr(original_ds, tag):
            setattr(single_frame_ds, tag, getattr(original_ds, tag))
    
    # Handle frame-specific timing information
    if hasattr(original_ds, 'FrameTime') and original_ds.FrameTime:
        # Calculate frame-specific timing
        frame_time_ms = float(original_ds.FrameTime)
        total_time_ms = frame_num * frame_time_ms
        
        # Update acquisition time if possible
        if hasattr(original_ds, 'AcquisitionTime'):
            try:
                base_time = original_ds.AcquisitionTime
                # Convert to seconds and add frame offset
                single_frame_ds.AcquisitionTime = base_time  # Simplified - could be more precise
            except:
                pass
        
        # Set frame-specific attributes
        single_frame_ds.FrameReferenceTime = total_time_ms
    
    # Handle temporal position
    if hasattr(original_ds, 'TemporalPositionIdentifier'):
        single_frame_ds.TemporalPositionIdentifier = frame_num + 1


def convert_multiframe_to_single_frames(input_path, output_dir):
    """
    Convert a multiframe DICOM file to multiple single-frame DICOM files.
    Uses enhanced pixel data extraction and ultrasound-specific metadata preservation.
    
    Args:
        input_path (str): Path to the multiframe DICOM file
        output_dir (str): Directory to save single-frame DICOM files
    
    Returns:
        bool: True if conversion was successful, False otherwise
    """
    # Temporarily enable debug logging for troubleshooting
    original_level = logger.level
    logger.setLevel(logging.DEBUG)
    
    try:
        # Read the multiframe DICOM
        logger.info(f"Reading multiframe DICOM file: {input_path}")
        ds = pydicom.dcmread(input_path)
        
        # Check if it's actually multiframe
        if not hasattr(ds, 'NumberOfFrames') or ds.NumberOfFrames <= 1:
            logger.info(f"File {input_path} is not multiframe or has only 1 frame")
            return False
        
        # Create output directory if it doesn't exist
        os.makedirs(output_dir, exist_ok=True)
        
        # Get base filename without extension
        base_filename = os.path.splitext(os.path.basename(input_path))[0]
        
        # Log detailed information about the multiframe image
        logger.info(f"Converting {ds.NumberOfFrames} frames from {input_path}")
        logger.info(f"Image dimensions: {ds.Rows}x{ds.Columns}, Bits: {ds.BitsAllocated}")
        
        # Log color/samples information
        samples_per_pixel = getattr(ds, 'SamplesPerPixel', 1)
        photometric = getattr(ds, 'PhotometricInterpretation', 'Unknown')
        logger.info(f"Samples per pixel: {samples_per_pixel}")
        logger.info(f"Photometric interpretation: {photometric}")
        
        # Additional debugging information
        if hasattr(ds, 'file_meta') and hasattr(ds.file_meta, 'TransferSyntaxUID'):
            logger.info(f"Transfer Syntax: {ds.file_meta.TransferSyntaxUID}")
        
        if hasattr(ds, 'PixelData'):
            logger.info(f"Pixel data size: {len(ds.PixelData)} bytes")
            
        # Calculate expected data sizes
        if samples_per_pixel > 1:
            logger.info(f"Color image detected - {samples_per_pixel} channels")
        else:
            logger.info("Grayscale image detected")
        
        # Try to get actual frame count from pixel array
        actual_frames = ds.NumberOfFrames
        pixel_array_frames = None
        pixel_array_shape = None
        
        try:
            pixel_array = ds.pixel_array
            pixel_array_shape = pixel_array.shape
            logger.info(f"Raw pixel array shape: {pixel_array_shape}")
            
            # Determine actual frame count based on array structure
            if len(pixel_array_shape) == 4:  # (frames, height, width, channels)
                if (pixel_array_shape[1] == ds.Rows and 
                    pixel_array_shape[2] == ds.Columns):
                    pixel_array_frames = pixel_array_shape[0]
                    logger.info(f"4D array detected: {pixel_array_frames} frames of {pixel_array_shape[1]}x{pixel_array_shape[2]}x{pixel_array_shape[3]}")
                else:
                    logger.warning(f"4D array with unexpected spatial dimensions: expected {ds.Rows}x{ds.Columns}, got {pixel_array_shape[1]}x{pixel_array_shape[2]}")
                    
            elif len(pixel_array_shape) == 3:  # Could be single frame (height, width, channels) or (height, width, frames)
                if (pixel_array_shape[0] == ds.Rows and 
                    pixel_array_shape[1] == ds.Columns):
                    # This is a single frame: (height, width, channels)
                    pixel_array_frames = 1
                    logger.info(f"3D single frame detected: {pixel_array_shape[0]}x{pixel_array_shape[1]}x{pixel_array_shape[2]}")
                    logger.warning("Expected multiframe data but got single frame - this may not be a true multiframe DICOM")
                else:
                    logger.warning(f"3D array with unexpected format: {pixel_array_shape}")
                    # Additional fallback: if the last dimension equals expected_samples, assume single-frame color image
                    if pixel_array_frames is None and samples_per_pixel > 1 and pixel_array_shape[-1] == samples_per_pixel:
                        logger.info(
                            "Fallback: treating 3D pixel array as single-frame based on channel dimension match"
                        )
                        pixel_array_frames = 1
            else:
                logger.warning(f"Unexpected pixel array dimensions: {len(pixel_array_shape)}D - {pixel_array_shape}")
            
            logger.info(f"DICOM header NumberOfFrames: {ds.NumberOfFrames}")
            logger.info(f"Pixel array detected frames: {pixel_array_frames}")
            
            if pixel_array_frames and pixel_array_frames != ds.NumberOfFrames:
                logger.warning(f"Frame count mismatch: DICOM header says {ds.NumberOfFrames}, pixel array has {pixel_array_frames}")
                
                # Special handling for single frame case
                if pixel_array_frames == 1 and ds.NumberOfFrames > 1:
                    logger.warning(f"DICOM claims {ds.NumberOfFrames} frames but pixel array only has 1 frame")
                    logger.warning("This appears to be a single-frame image mislabeled as multiframe")
                    logger.info("Will process as single frame")
                    # Don't return False - let the single-frame handler deal with this
                elif pixel_array_frames > 1:
                    logger.info(f"Using pixel array frame count: {pixel_array_frames}")
                    actual_frames = pixel_array_frames
            else:
                logger.info(f"Frame counts match: {actual_frames}")
                
        except Exception as e:
            logger.warning(f"Could not read pixel array for frame count verification: {e}")
            logger.info(f"Falling back to DICOM header NumberOfFrames: {actual_frames}")
        
        # Additional validation - but don't fail on single frame case
        if actual_frames <= 1 and pixel_array_frames != 1:
            if pixel_array_frames and pixel_array_frames > 1:
                logger.info(f"Overriding with pixel array frame count: {pixel_array_frames}")
                actual_frames = pixel_array_frames
            else:
                logger.error("Cannot determine valid frame count - this may not be a multiframe DICOM")
                return False
                
        # Final validation before processing - remove the problematic check
        # The single-frame handler will deal with dimension mismatches
        
        # Check for ultrasound modality
        is_ultrasound = hasattr(ds, 'Modality') and ds.Modality == 'US'
        if is_ultrasound:
            logger.info("Detected ultrasound modality - applying US-specific processing")
        
        # Debug logging for frame detection
        logger.info(f"DEBUG: pixel_array_frames = {pixel_array_frames}")
        logger.info(f"DEBUG: actual_frames = {actual_frames}")
        logger.info(f"DEBUG: ds.NumberOfFrames = {ds.NumberOfFrames}")
        
        # Handle single-frame case (even if header claims multiframe)
        if pixel_array_frames == 1:
            logger.info("Detected single-frame data - creating single output file instead of multiple frames")
            
            # Create a copy of the original dataset
            single_frame_ds = ds.copy()
            
            # Update metadata for single frame
            single_frame_ds.NumberOfFrames = 1
            
            # Extract the single frame
            frame_pixel_data = extract_frame_pixel_data(ds, 0)
            if frame_pixel_data is None:
                logger.error("Failed to extract pixel data from single frame")
                return False
            
            single_frame_ds.PixelData = frame_pixel_data
            
            # Update metadata
            single_frame_ds.InstanceNumber = 1
            single_frame_ds.SOPInstanceUID = pydicom.uid.generate_uid()
            
            # Set samples per pixel correctly
            if samples_per_pixel > 1:
                single_frame_ds.SamplesPerPixel = samples_per_pixel
                if not hasattr(single_frame_ds, 'PhotometricInterpretation'):
                    if samples_per_pixel == 3:
                        single_frame_ds.PhotometricInterpretation = 'RGB'
                    else:
                        single_frame_ds.PhotometricInterpretation = 'MONOCHROME2'
            else:
                single_frame_ds.SamplesPerPixel = 1
                if not hasattr(single_frame_ds, 'PhotometricInterpretation'):
                    single_frame_ds.PhotometricInterpretation = 'MONOCHROME2'
            
            # Remove multiframe-specific attributes
            multiframe_attrs = [
                'PerFrameFunctionalGroupsSequence',
                'SharedFunctionalGroupsSequence'
            ]
            
            for attr in multiframe_attrs:
                if hasattr(single_frame_ds, attr):
                    delattr(single_frame_ds, attr)
            
            # Preserve ultrasound-specific metadata
            if is_ultrasound:
                preserve_ultrasound_metadata(single_frame_ds, ds, 0)
            
            # Ensure uncompressed transfer syntax
            if hasattr(single_frame_ds, 'file_meta'):
                single_frame_ds.file_meta.TransferSyntaxUID = '1.2.840.10008.1.2.1'  # Explicit VR Little Endian
            
            # Save the single frame
            output_filename = f"{base_filename}_single_frame.dcm"
            output_path = os.path.join(output_dir, output_filename)
            
            single_frame_ds.save_as(output_path, write_like_original=False)
            
            logger.info(f"Successfully saved single frame as: {output_path}")
            logger.info("Single-frame conversion completed - exiting function")
            return True
        
        # If we reach here, it means we didn't detect single frame, so log why
        logger.info(f"Single-frame handler not triggered: pixel_array_frames={pixel_array_frames} (expected 1)")
        
        # Fallback check: if we're about to process multiple frames but pixel array is single frame
        if pixel_array_shape is not None and len(pixel_array_shape) == 3:
            if (pixel_array_shape[0] == ds.Rows and 
                pixel_array_shape[1] == ds.Columns and 
                actual_frames > 1):
                logger.error("CRITICAL: About to process multiple frames from single-frame pixel array!")
                logger.error(f"Pixel array shape: {pixel_array_shape}, but frames_to_process: {actual_frames}")
                logger.error("This will cause extraction errors - forcing single frame processing")
                
                # Force single frame processing
                logger.info("Forcing single-frame conversion as fallback")
                
                # Create a copy of the original dataset
                single_frame_ds = ds.copy()
                single_frame_ds.NumberOfFrames = 1
                
                # Extract the single frame
                frame_pixel_data = extract_frame_pixel_data(ds, 0)
                if frame_pixel_data is None:
                    logger.error("Failed to extract pixel data from single frame in fallback")
                    return False
                
                single_frame_ds.PixelData = frame_pixel_data
                single_frame_ds.InstanceNumber = 1
                single_frame_ds.SOPInstanceUID = pydicom.uid.generate_uid()
                
                # Set samples per pixel correctly
                if samples_per_pixel > 1:
                    single_frame_ds.SamplesPerPixel = samples_per_pixel
                    if not hasattr(single_frame_ds, 'PhotometricInterpretation'):
                        if samples_per_pixel == 3:
                            single_frame_ds.PhotometricInterpretation = 'RGB'
                        else:
                            single_frame_ds.PhotometricInterpretation = 'MONOCHROME2'
                else:
                    single_frame_ds.SamplesPerPixel = 1
                    if not hasattr(single_frame_ds, 'PhotometricInterpretation'):
                        single_frame_ds.PhotometricInterpretation = 'MONOCHROME2'
                
                # Remove multiframe-specific attributes
                multiframe_attrs = [
                    'PerFrameFunctionalGroupsSequence',
                    'SharedFunctionalGroupsSequence'
                ]
                
                for attr in multiframe_attrs:
                    if hasattr(single_frame_ds, attr):
                        delattr(single_frame_ds, attr)
                
                # Preserve ultrasound-specific metadata
                if is_ultrasound:
                    preserve_ultrasound_metadata(single_frame_ds, ds, 0)
                
                # Ensure uncompressed transfer syntax
                if hasattr(single_frame_ds, 'file_meta'):
                    single_frame_ds.file_meta.TransferSyntaxUID = '1.2.840.10008.1.2.1'
                
                # Save the single frame
                output_filename = f"{base_filename}_single_frame_fallback.dcm"
                output_path = os.path.join(output_dir, output_filename)
                
                single_frame_ds.save_as(output_path, write_like_original=False)
                
                logger.info(f"Successfully saved single frame via fallback: {output_path}")
                return True
        
        # Extract each frame - use the corrected frame count
        successful_frames = 0
        frames_to_process = actual_frames
        
        logger.info(f"Starting conversion of {frames_to_process} frames")
        
        for frame_num in range(frames_to_process):
            try:
                logger.debug(f"Processing frame {frame_num + 1}/{frames_to_process}")
                
                # Create a copy of the original dataset
                single_frame_ds = ds.copy()
                
                # Modify for single frame
                single_frame_ds.NumberOfFrames = 1
                
                # Extract pixel data for this frame using enhanced method
                frame_pixel_data = extract_frame_pixel_data(ds, frame_num)
                if frame_pixel_data is None:
                    logger.error(f"Failed to extract pixel data for frame {frame_num}")
                    continue
                
                # Enhanced validation for RGB/color images
                expected_pixel_count = ds.Rows * ds.Columns * samples_per_pixel
                bytes_per_pixel = ds.BitsAllocated // 8
                expected_bytes = expected_pixel_count * bytes_per_pixel
                
                logger.debug(f"Frame {frame_num} validation:")
                logger.debug(f"  Dimensions: {ds.Rows}x{ds.Columns}, Samples/Pixel: {samples_per_pixel}")
                logger.debug(f"  Expected pixels: {expected_pixel_count}, Bytes/pixel: {bytes_per_pixel}")
                logger.debug(f"  Expected bytes: {expected_bytes}, Got bytes: {len(frame_pixel_data)}")
                
                if len(frame_pixel_data) != expected_bytes:
                    logger.warning(f"Frame {frame_num}: Expected {expected_bytes} bytes, got {len(frame_pixel_data)} bytes")
                    
                    # For numpy-extracted data, this might be normal due to different byte ordering
                    # Try to validate based on total data size
                    if len(frame_pixel_data) == expected_pixel_count:
                        logger.info(f"Frame {frame_num}: Byte count matches pixel count - likely valid data")
                    elif len(frame_pixel_data) == expected_pixel_count * samples_per_pixel:
                        logger.info(f"Frame {frame_num}: Byte count includes all color channels - valid data")
                    else:
                        logger.error(f"Frame {frame_num}: Invalid pixel data size - skipping")
                        continue
                
                single_frame_ds.PixelData = frame_pixel_data
                
                # Update pixel-related metadata for single frame
                if hasattr(single_frame_ds, 'NumberOfFrames'):
                    single_frame_ds.NumberOfFrames = 1
                
                # Ensure samples per pixel is correct for color vs grayscale
                if samples_per_pixel > 1:
                    single_frame_ds.SamplesPerPixel = samples_per_pixel
                    # Ensure photometric interpretation is set correctly
                    if not hasattr(single_frame_ds, 'PhotometricInterpretation'):
                        if samples_per_pixel == 3:
                            single_frame_ds.PhotometricInterpretation = 'RGB'
                        elif samples_per_pixel == 1:
                            single_frame_ds.PhotometricInterpretation = 'MONOCHROME2'
                    logger.debug(f"Frame {frame_num}: Set SamplesPerPixel={samples_per_pixel}, PhotometricInterpretation={single_frame_ds.PhotometricInterpretation}")
                else:
                    single_frame_ds.SamplesPerPixel = 1
                    if not hasattr(single_frame_ds, 'PhotometricInterpretation'):
                        single_frame_ds.PhotometricInterpretation = 'MONOCHROME2'
                
                # Update frame-specific metadata from functional groups
                if hasattr(ds, 'PerFrameFunctionalGroupsSequence') and frame_num < len(ds.PerFrameFunctionalGroupsSequence):
                    # Extract frame-specific functional groups
                    frame_functional_groups = ds.PerFrameFunctionalGroupsSequence[frame_num]
                    
                    # Apply frame-specific metadata to the single frame dataset
                    for group_name, group_data in frame_functional_groups.items():
                        if hasattr(group_data, '__iter__') and not isinstance(group_data, str):
                            # Handle sequence data
                            for item in group_data:
                                for elem in item:
                                    try:
                                        setattr(single_frame_ds, elem.keyword, elem.value)
                                    except:
                                        pass  # Skip if can't set attribute
                
                # Apply shared functional groups before removing
                if hasattr(ds, 'SharedFunctionalGroupsSequence'):
                    shared_groups = ds.SharedFunctionalGroupsSequence
                    for group_name, group_data in shared_groups.items():
                        if hasattr(group_data, '__iter__') and not isinstance(group_data, str):
                            for item in group_data:
                                for elem in item:
                                    try:
                                        setattr(single_frame_ds, elem.keyword, elem.value)
                                    except:
                                        pass
                
                # Remove multiframe-specific attributes
                multiframe_attrs = [
                    'PerFrameFunctionalGroupsSequence',
                    'SharedFunctionalGroupsSequence'
                ]
                
                for attr in multiframe_attrs:
                    if hasattr(single_frame_ds, attr):
                        delattr(single_frame_ds, attr)
                
                # Update instance-specific metadata
                single_frame_ds.InstanceNumber = frame_num + 1
                
                # Generate unique SOP Instance UID for each frame
                single_frame_ds.SOPInstanceUID = pydicom.uid.generate_uid()
                
                # Preserve ultrasound-specific metadata
                if is_ultrasound:
                    preserve_ultrasound_metadata(single_frame_ds, ds, frame_num)
                
                # Ensure pixel data is uncompressed for compatibility
                if hasattr(single_frame_ds, 'file_meta'):
                    single_frame_ds.file_meta.TransferSyntaxUID = '1.2.840.10008.1.2.1'  # Explicit VR Little Endian
                
                # Save the single frame
                output_filename = f"{base_filename}_frame_{frame_num:03d}.dcm"
                output_path = os.path.join(output_dir, output_filename)
                
                single_frame_ds.save_as(output_path, write_like_original=False)
                successful_frames += 1
                
                if successful_frames % 10 == 0:  # Log progress every 10 frames
                    logger.info(f"Successfully converted {successful_frames}/{frames_to_process} frames")
                
            except Exception as e:
                logger.warning(f"Failed to extract frame {frame_num}: {e}")
                continue
        
        logger.info(f"Successfully converted {successful_frames}/{frames_to_process} frames")
        return successful_frames > 0
        
    except Exception as e:
        logger.error(f"Failed to convert multiframe DICOM {input_path}: {e}")
        return False
    finally:
        # Restore original logging level
        logger.setLevel(original_level)


def handle_ultrasound_specifics(image, series_dir):
    """
    Handle ultrasound-specific image processing considerations.
    
    Args:
        image: SimpleITK image object
        series_dir: Directory path or file path of the source DICOM
    
    Returns:
        SimpleITK image: Processed image
    """
    try:
        # Check if we're dealing with ultrasound
        is_ultrasound = False
        if image.HasMetaDataKey("0008|0060"):  # Modality tag
            modality = image.GetMetaData("0008|0060")
            is_ultrasound = (modality == 'US')
        
        if not is_ultrasound:
            return image
        
        logger.info("Applying ultrasound-specific processing")
        
        # Get image dimensions and components
        size = image.GetSize()
        components = image.GetNumberOfComponentsPerPixel()
        
        logger.info(f"Original image size: {size}, Components per pixel: {components}")
        
        # Handle color images first
        if components > 1:
            logger.info(f"Color ultrasound detected with {components} components")
            # Convert to grayscale using VectorIndexSelectionCast
            vector_selector = SimpleITK.VectorIndexSelectionCastImageFilter()
            vector_selector.SetIndex(0)  # Select first channel
            image = vector_selector.Execute(image)
            logger.info("Converted color image to grayscale")
        
        # Get image array for dimension checking
        image_array = SimpleITK.GetArrayFromImage(image)
        logger.info(f"Image array shape: {image_array.shape}")
        
        # Handle dimension mismatch
        if len(image_array.shape) > 2:
            # If we have a 3D array but it's actually a 2D image with color channels
            if image_array.shape[-1] in [3, 4]:  # RGB or RGBA
                logger.info("Detected color channels in last dimension")
                # Take first channel and reshape to 2D
                image_array = image_array[..., 0]
            elif image_array.shape[0] in [3, 4]:  # Color channels in first dimension
                logger.info("Detected color channels in first dimension")
                image_array = image_array[0]
        
        # Ensure we have a 2D image
        if len(image_array.shape) > 2:
            logger.info(f"Reducing dimensions from {len(image_array.shape)} to 2")
            if image_array.shape[0] == 1:  # Single frame in first dimension
                image_array = image_array[0]
            else:
                # Take the middle frame if multiple frames
                middle_frame = image_array.shape[0] // 2
                image_array = image_array[middle_frame]
        
        # Create new image from processed array
        processed_image = SimpleITK.GetImageFromArray(image_array)
        
        # Copy metadata from original image
        for key in image.GetMetaDataKeys():
            processed_image.SetMetaData(key, image.GetMetaData(key))
        
        # Copy physical information
        processed_image.SetSpacing(image.GetSpacing()[:2])  # Only take X,Y spacing
        processed_image.SetOrigin(image.GetOrigin()[:2])  # Only take X,Y origin
        direction = image.GetDirection()[:2]  # Only take X,Y direction
        processed_image.SetDirection(direction)
        
        logger.info(f"Final processed image size: {processed_image.GetSize()}")
        return processed_image
        
    except Exception as e:
        logger.error(f"Error in ultrasound-specific processing: {e}")
        logger.warning("Returning original image due to processing error")
        return image


def dicom_to_nifti(series_dir, is_seg=False):
    """
    Convert DICOM series to NIFTI format, handling both 2D and 3D images.
    
    Args:
        series_dir: Directory containing DICOM files or path to single DICOM file
        is_seg: Whether this is a segmentation DICOM
        
    Returns:
        str: Path to output NIFTI file
    """
    start = time.time()

    if is_seg:
        output_file = dicom_seg_to_itk_image(series_dir)
    else:
        original_series_dir = series_dir
        
        try:
            # Check if dealing with single DICOM file that might be multi-frame
            if not os.path.isdir(series_dir):
                # Single file - check if it's multi-frame ultrasound
                try:
                    ds = pydicom.dcmread(series_dir, stop_before_pixels=True)
                    is_multiframe = hasattr(ds, 'NumberOfFrames') and ds.NumberOfFrames > 1
                    is_ultrasound = hasattr(ds, 'Modality') and ds.Modality == 'US'
                    
                    if is_multiframe and is_ultrasound:
                        logger.info(f"Detected multi-frame ultrasound DICOM with {ds.NumberOfFrames} frames")
                        # Handle multi-frame DICOM conversion
                        return handle_multiframe_ultrasound_dicom(series_dir, ds)
                except Exception as e:
                    logger.warning(f"Could not check for multi-frame: {e}")
                
                # Standard single file processing
                file_reader = SimpleITK.ImageFileReader()
                file_reader.SetImageIO("GDCMImageIO")
                file_reader.SetFileName(series_dir)
                image = file_reader.Execute()
            else:
                # Directory processing - check for multi-frame ultrasound first
                reader = SimpleITK.ImageSeriesReader()
                dicom_names = reader.GetGDCMSeriesFileNames(series_dir)
                if not dicom_names:
                    raise ValueError(f"No DICOM files found in {series_dir}")
                
                # Check first DICOM file for multi-frame ultrasound
                first_dicom = dicom_names[0]
                try:
                    ds = pydicom.dcmread(first_dicom, stop_before_pixels=True)
                    is_multiframe = hasattr(ds, 'NumberOfFrames') and ds.NumberOfFrames > 1
                    is_ultrasound = hasattr(ds, 'Modality') and ds.Modality == 'US'
                    
                    if is_multiframe and is_ultrasound:
                        logger.info(f"Detected multi-frame ultrasound DICOM in directory with {ds.NumberOfFrames} frames")
                        # Handle multi-frame DICOM conversion using first file
                        return handle_multiframe_ultrasound_dicom(first_dicom, ds)
                except Exception as e:
                    logger.warning(f"Could not check directory DICOM for multi-frame: {e}")
                
                # Standard directory processing
                reader.SetFileNames(dicom_names)
                image = reader.Execute()

            # Log original image properties
            logger.info(f"Original image size: {image.GetSize()}")
            logger.info(f"Original components per pixel: {image.GetNumberOfComponentsPerPixel()}")
            
            # Apply ultrasound-specific processing
            image = handle_ultrasound_specifics(image, series_dir)
            
            # Get image array and check dimensions
            image_array = SimpleITK.GetArrayFromImage(image)
            logger.info(f"Processed image array shape: {image_array.shape}")
            
            # Handle 2D images - expand to 3D with depth=1
            if image_array.ndim == 2:
                logger.info("2D image detected - expanding to pseudo-3D (depth=1)")
                image_array = image_array[np.newaxis, ...]  # Add Z dimension: (1, Y, X)
            
            # Create output image with proper metadata
            output_image = SimpleITK.GetImageFromArray(image_array)
            
            # Copy/fix metadata
            if image.GetDimension() == 2:
                logger.info("Setting 3D metadata for 2D image")
                sx, sy = image.GetSpacing()
                ox, oy = image.GetOrigin()
                output_image.SetSpacing((sx, sy, 1.0))
                output_image.SetOrigin((ox, oy, 0.0))
                # Set identity direction matrix for 3D
                output_image.SetDirection((1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0))
            else:
                output_image.CopyInformation(image)
            
            # Save as NIFTI
            output_file = original_series_dir + ".nii.gz"
            SimpleITK.WriteImage(output_image, output_file)
            
            logger.info(f"Final image shape: {image_array.shape}")
            logger.info(f"Output file: {output_file}")
            
        except Exception as e:
            logger.error(f"Error in DICOM to NIFTI conversion: {e}")
            raise

    logger.info(f"dicom_to_nifti latency: {time.time() - start} (sec)")
    return output_file


def handle_multiframe_ultrasound_dicom(dicom_path, ds=None):
    """
    Handle multi-frame ultrasound DICOM by extracting first frame and converting to NIfTI.
    
    Args:
        dicom_path: Path to the multi-frame DICOM file
        ds: Optional pre-loaded DICOM dataset
    
    Returns:
        str: Path to output NIfTI file
    """
    try:
        # Always read the full DICOM with pixel data for multi-frame processing
        ds = pydicom.dcmread(dicom_path)
        
        logger.info(f"Processing multi-frame ultrasound with {ds.NumberOfFrames} frames")
        
        # Direct conversion from numpy array to SimpleITK image
        try:
            # Extract first frame pixel data directly
            pixel_array = ds.pixel_array
            logger.info(f"Original pixel array shape: {pixel_array.shape}")
            
            if len(pixel_array.shape) > 2:  # Multi-frame
                first_frame = pixel_array[0]  # Take first frame
                logger.info(f"First frame shape: {first_frame.shape}")
            else:
                first_frame = pixel_array
            
            # Convert numpy array directly to SimpleITK image
            image = SimpleITK.GetImageFromArray(first_frame)
            
            # Set physical properties from DICOM metadata
            if hasattr(ds, 'PixelSpacing'):
                spacing = [float(ds.PixelSpacing[0]), float(ds.PixelSpacing[1])]
                image.SetSpacing(spacing)
                logger.info(f"Set pixel spacing: {spacing}")
            
            if hasattr(ds, 'ImagePositionPatient'):
                origin = [float(x) for x in ds.ImagePositionPatient[:2]]  # 2D image
                image.SetOrigin(origin)
                logger.info(f"Set origin: {origin}")
                
            logger.info(f"Created SimpleITK image with size: {image.GetSize()}")
            
        except Exception as e:
            logger.error(f"Error in direct numpy to SimpleITK conversion: {e}")
            raise e
        
        # Apply ultrasound-specific processing
        image = handle_ultrasound_specifics(image, os.path.dirname(dicom_path))
        
        # Get image array and ensure proper dimensions
        image_array = SimpleITK.GetArrayFromImage(image)
        logger.info(f"Multi-frame processed image array shape: {image_array.shape}")
        
        # Ensure 3D shape
        if image_array.ndim == 2:
            image_array = image_array[np.newaxis, ...]  # Add Z dimension
        
        # Create output image
        output_image = SimpleITK.GetImageFromArray(image_array)
        
        # Set proper metadata
        if image.GetDimension() == 2:
            sx, sy = image.GetSpacing()
            ox, oy = image.GetOrigin()
            output_image.SetSpacing((sx, sy, 1.0))
            output_image.SetOrigin((ox, oy, 0.0))
            # Set identity direction matrix for 3D
            output_image.SetDirection((1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0))
        else:
            output_image.CopyInformation(image)
        
        # Save as NIfTI
        output_file = dicom_path + ".nii.gz"
        SimpleITK.WriteImage(output_image, output_file)
        
        logger.info(f"Multi-frame ultrasound conversion completed: {output_file}")
        return output_file
        
    except Exception as e:
        logger.error(f"Error in multi-frame ultrasound processing: {e}")
        raise e


def binary_to_image(reference_image, label, dtype=np.uint8, file_ext=".nii.gz"):
    start = time.time()

    image_np, meta_dict = LoadImage(image_only=False)(reference_image)
    label_np = np.fromfile(label, dtype=dtype)

    logger.info(f"Image: {image_np.shape}")
    logger.info(f"Label: {label_np.shape}")

    label_np = label_np.reshape(image_np.shape, order="F")
    logger.info(f"Label (reshape): {label_np.shape}")

    output_file = tempfile.NamedTemporaryFile(suffix=file_ext).name
    affine = meta_dict.get("affine")
    write_itk(label_np, output_file, affine=affine, dtype=None, compress=True)

    logger.info(f"binary_to_image latency : {time.time() - start} (sec)")
    return output_file


def nifti_to_dicom_seg(series_dir, label, prompt_json, file_ext="*", use_itk=True) -> str:
    start = time.time()

    # Read source Images
    series_dir = pathlib.Path(series_dir)
    image_files = series_dir.glob(file_ext)
    
    # Filter and read only valid DICOM files
    image_datasets = []
    for f in image_files:
        # Skip non-DICOM files (like .nii.gz files)
        if str(f).lower().endswith(('.nii.gz', '.nii', '.json', '.txt', '.log')):
            continue
        
        try:
            ds = dcmread(str(f), stop_before_pixels=True)
            image_datasets.append(ds)
        except Exception as e:
            logger.warning(f"Could not read {f} as DICOM: {e}")
            # Try with force=True for problematic files
            try:
                ds = dcmread(str(f), stop_before_pixels=True, force=True)
                image_datasets.append(ds)
                logger.info(f"Successfully read {f} with force=True")
            except Exception as e2:
                logger.warning(f"Could not read {f} even with force=True: {e2}")
                continue
    
    logger.info(f"Total Source Images: {len(image_datasets)}")
    
    if len(image_datasets) == 0:
        logger.error("No valid DICOM files found for segmentation generation")
        return ""
    
    if 0x0008103e in image_datasets[0].keys():
        image_series_desc = image_datasets[0][0x0008103e].value
    else:
        image_series_desc = ""

    label_np, meta_dict = LoadImage(image_only=False)(label)
    unique_labels = np.unique(label_np.flatten()).astype(np.int_)
    unique_labels = unique_labels[unique_labels != 0]

    #info = label_info[0] if label_info and 0 < len(label_info) else {}
    info = {}
    #model_name = info.get("model_name", "Totalsegmentor")
    if "sam" in label:
        # For SAM outputs, we may have multiple numeric labels. Provide default names.
        label_names = ["sam_label"]
        image_series_desc = "SAM2_"+ image_series_desc
    else:
        try:
            label_names = np.load('/code/labelname.npy').tolist()
        except Exception as e:
            logger.warning(f"Could not load label names from /code/labelname.npy: {e}")
            label_names = []
        image_series_desc = "Total_"+ image_series_desc
    segment_attributes = []

    for i, idx in enumerate(unique_labels):
        # Retrieve label name safely; generate fallback if not available
        label_info = {}
        if i < len(label_names):
            name = label_names[i]
        else:
            name = f"Label_{int(idx)}"
            logger.debug(f"Generated fallback name '{name}' for label index {i} (ID={idx})")
        description = label_info.get("description", json.dumps(prompt_json))
        rgb = list(np.random.random(size=3) * 256)
        rgb = [int(x) for x in rgb]

        logger.info(f"{i} => {idx} => {name}")

        segment_attribute = label_info.get(
            "segmentAttribute",
            {
                "labelID": int(idx),
                "SegmentLabel": name,
                "SegmentDescription": description,
                "SegmentAlgorithmType": "AUTOMATIC",
                "SegmentAlgorithmName": "MONAILABEL",
                "SegmentedPropertyCategoryCodeSequence": {
                    "CodeValue": "123037004",
                    "CodingSchemeDesignator": "SCT",
                    "CodeMeaning": "Anatomical Structure",
                },
                "SegmentedPropertyTypeCodeSequence": {
                    "CodeValue": "78961009",
                    "CodingSchemeDesignator": "SCT",
                    "CodeMeaning": name,
                },
                "recommendedDisplayRGBValue": rgb,
            },
        )
        segment_attributes.append(segment_attribute)

    template = {
        "ContentCreatorName": "Reader1",
        "ClinicalTrialSeriesID": "Session1",
        "ClinicalTrialTimePointID": "1",
        "SeriesDescription": image_series_desc,
        "SeriesNumber": "300",
        "InstanceNumber": "1",
        "segmentAttributes": [segment_attributes],
        "ContentLabel": "SEGMENTATION",
        "ContentDescription": "MONAI Label - Image segmentation",
        "ClinicalTrialCoordinatingCenterName": "MONAI",
        "BodyPartExamined": "",
    }
#    template = {
#  "ContentCreatorName": "SAM2",
#  "ClinicalTrialSeriesID": "Session1",
#  "ClinicalTrialTimePointID": "1",
#  "SeriesDescription": image_series_desc,
#  "SeriesNumber": "300",
#  "InstanceNumber": "1",
#  "segmentAttributes": [
#    [
#      {
#        "labelID": 1,
#        "SegmentDescription": "bone",
#        "SegmentAlgorithmType": "SEMIAUTOMATIC",
#        "SegmentAlgorithmName": "SAM2",
#        "SegmentedPropertyCategoryCodeSequence": {
#          "CodeValue": "91723000",
#          "CodingSchemeDesignator": "SCT",
#          "CodeMeaning": "Anatomical Structure"
#        },
#        "SegmentedPropertyTypeCodeSequence": {
#          "CodeValue": "818981001",
#          "CodingSchemeDesignator": "SCT",
#          "CodeMeaning": "Abdomen"
#        },
#        "recommendedDisplayRGBValue": [
#          177,
#          122,
#          101
#        ]
#      }
#    ]
#  ],
#  "ContentLabel": "SEGMENTATION",
#  "ContentDescription": "Image segmentation",
#  "ClinicalTrialCoordinatingCenterName": "dcmqi",
#  "BodyPartExamined": ""
#}


    logger.info(json.dumps(template, indent=2))
    if not segment_attributes:
        logger.error("Missing Attributes/Empty Label provided")
        return ""

    use_itk=True
    
    if use_itk:
        output_file = itk_image_to_dicom_seg(label, series_dir, template)
    else:
        template = pydicom_seg.template.from_dcmqi_metainfo(template)
        config.settings.reading_validation_mode = config.IGNORE
        writer = pydicom_seg.MultiClassWriter(
            template=template,
            inplane_cropping=False,
            skip_empty_slices=False,
            skip_missing_segment=False,
        )

        mask = SimpleITK.ReadImage(label)
        mask = SimpleITK.Cast(mask, SimpleITK.sitkUInt16)

        output_file = "/code/test.dcm"
        dcm = writer.write(mask, image_datasets)
        dcm.save_as(output_file)

    logger.info(f"nifti_to_dicom_seg latency : {time.time() - start} (sec)")
    return output_file


def itk_image_to_dicom_seg(label, series_dir, template) -> str:
    output_file = tempfile.NamedTemporaryFile(suffix=".dcm", delete=False).name
    meta_data = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
    #Resampling code below
    #reader = SimpleITK.ImageSeriesReader()
    #dicom_filenames = reader.GetGDCMSeriesFileNames(series_dir)
    #reader.SetFileNames(dicom_filenames)
    #dcm_img_sample = dcmread(dicom_filenames[0], stop_before_pixels=True)
#
    #source_image = reader.Execute()
#
    #segmentation = SimpleITK.ReadImage(label)
#
    #resampler = SimpleITK.ResampleImageFilter()
    #resampler.SetReferenceImage(source_image)
    #resampler.SetInterpolator(SimpleITK.sitkNearestNeighbor)  # Use nearest-neighbor for label images
    #resampler.SetOutputSpacing(source_image.GetSpacing())
    #resampler.SetOutputOrigin(source_image.GetOrigin())
    #resampler.SetOutputDirection(source_image.GetDirection())
    #resampled_segmentation = resampler.Execute(segmentation)
#
    #SimpleITK.WriteImage(resampled_segmentation, label)
#
    #seg_image = SimpleITK.ReadImage(label)
    #logger.info(f"Origin: {seg_image.GetOrigin()}")
    #logger.info(f"Spacing: {seg_image.GetSpacing()}")
    #logger.info(f"Direction: {seg_image.GetDirection()}")

    with open(meta_data, "w") as fp:
        json.dump(template, fp)

    command = "itkimage2segimage"
    args = [
        "--inputImageList",
        label,
        "--inputDICOMDirectory",
        series_dir,
        "--outputDICOM",
        output_file,
        "--inputMetadata",
        meta_data,
    ]
    run_command(command, args)
    
    # Clean up temporary metadata file
    try:
        os.unlink(meta_data)
    except FileNotFoundError:
        logger.warning(f"Metadata file {meta_data} not found for cleanup")
    
    return output_file


def dicom_seg_to_itk_image(label, output_ext=".seg.nrrd"):
    filename = label if not os.path.isdir(label) else os.path.join(label, os.listdir(label)[0])

    dcm = pydicom.dcmread(filename)
    reader = pydicom_seg.MultiClassReader()
    result = reader.read(dcm)
    image = result.image

    output_file = tempfile.NamedTemporaryFile(suffix=output_ext).name

    SimpleITK.WriteImage(image, output_file, True)

    if not os.path.exists(output_file):
        logger.warning(f"Failed to convert DICOM-SEG {label} to ITK image")
        return None

    logger.info(f"Result/Output File: {output_file}")
    return output_file

