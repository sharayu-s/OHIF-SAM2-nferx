# MONAI Label + Totalsegmentator

### Overview

<img src="https://github.com/needinc/monai-label/blob/totalsegmentator/docs/images/total/overview_workflow_total.png?raw=true" alt="Current Workflow" width="100%"/>

MonaiLabel: server: download & upload dcm to DicomStore, do data conversion (dicom->nifti->dicom) and inference using Totalsegmentator API 

### Prerequisites

- Change ohif dist for monai, `line 7 at Dockerfile -> 3.8/3.8monaiSAM15.zip`
- Prepare conda environment via miniconda or anaconda
- GPU Instance

### Setup
- MONAI-Label server: At GPU instance running the following commands:
 <pre>
  git clone https://github.com/needinc/monai-label.git
  conda create -n monai-total python=3.10
  conda activate monai-total
  pip install -r monai-label/requirements.txt
  export PATH=$PATH:`pwd`/monai-label/monailabel/scripts</pre>

  Should be able to run `monailabel`

  Then run the below.
  <pre>monailabel apps --download --name radiology --output apps</pre>

- Hero app: has to be rebuilt with `3.8monaiSAM15.zip`
<pre>docker-compose up --build</pre>
### Workflow
- Search with `/home/cho/' in the repository. Then, you'll find `/home/cho/MONAILabel/labelname`, /home/cho/MONAILabel/labelname.npy` (Label names are saved and reloaded later via npy file), `/home/cho/MONAILabel/test.dcm` (A predicted nifti file is converted to DICOM file), `/home/cho/MONAILabel/total` (All predicted labels, including empty labels, are saved at this location) and `/home/cho/MONAILabel/sum.nii.gz` (Only valid labels are added into the `sum.nii.gz` file). These paths should be updated for other dev environment.
- To run MONAI-Label server, run the following command lines with customized path for gcp-sa.json and GCP DICOMweb. Plus port number. The port number should be configured to be accessible.
<pre>
  CUDA_VISIBLE_DEVICES=1 GOOGLE_APPLICATION_CREDENTIALS=/home/cho/MONAILabel/keys/gcp-sa.json monailabel start_server --app apps/radiology --studies https://healthcare.googleapis.com/v1/projects/newco-dev-290721/locations/us-west2/datasets/ntg-local/dicomStores/main/dicomWeb --conf models segmentation -p 8002</pre>

To check whether it runs properly or not, access http://localhost:8002, and you'll see:

<img src="https://github.com/needinc/monai-label/blob/totalsegmentator/docs/images/total/monai_label_api.png?raw=true" alt="Monai Label API page" width="100%"/>

- At hero app, click one image (CT or MR), which you want to segment.
1. Click 'MONAI Totalsegmentator' button, that's it. You might need to comment out `self._assert_uid_format(series_instance_uid || study_instance_uid)`at `/home/cho/miniconda3/envs/monai-sam/lib/python3.10/site-packages/dicomweb_client/web.py` to avoid UID format checks