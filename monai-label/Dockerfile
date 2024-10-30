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

FROM nvidia/cuda:12.6.1-devel-ubuntu22.04
#FROM python:3.10-slim

RUN apt update -y && apt install -y openslide-tools build-essential python3-pip python3-dev python-is-python3 ffmpeg libsm6 libxext6 wget

WORKDIR /code
RUN mkdir -p /install
COPY ./monai-label/requirements.txt ./
COPY ./sam2/. /install/
#ENV LD_LIBRARY_PATH=$LD_LIBRARY_PATH":/usr/lib/x86_64-linux-gnu:"
ENV LD_LIBRARY_PATH=$LD_LIBRARY_PATH:"/usr/local/nvidia/lib64"

RUN pip install --upgrade pip setuptools wheel
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install -e /install/.
COPY ./monai-label/. ./

ENV WEIGHTS_DIR="/code/checkpoints/"
ENV WEIGHTS_URL="https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_large.pt"

RUN wget --directory-prefix ${WEIGHTS_DIR} ${WEIGHTS_URL}

RUN rm -rf /usr/local/lib/python3.10/dist-packages/dicomweb_client/web.py

COPY ./monai-label/backup/web.py /usr/local/lib/python3.10/dist-packages/dicomweb_client/

ENV CUDA_VISIBLE_DEVICES=1
ENV PATH=$PATH":/code/monailabel/scripts"

RUN monailabel apps --download --name radiology --output /code/apps
EXPOSE 8002
CMD ["monailabel", "start_server", "--app", "/code/apps/radiology", "--studies", "http://ohif_orthanc:1026/pacs/dicom-web", "--conf", "models", "segmentation", "--conf", "use_pretrained_model", "false", "-p", "8002"]