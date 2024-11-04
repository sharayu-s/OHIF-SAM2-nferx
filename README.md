# OHIF-SAM2

## Prerequisite

- Install Docker, NVIDIA Container Toolkit

- tested version: Docker: 27.3.1, NVIDIA Container Toolkit: 1.16.2, CUDA Version: 12.6

## Getting Started

- Run `bash start.sh`
- Go to http://localhost:1026
- Upload all DICOM files in sample-data

## Demo Video

[![OHIF-SAM2 Demo](https://img.youtube.com/vi/BS2wCKYh_pk/0.jpg)](https://www.youtube.com/watch?v=BS2wCKYh_pk)

- Prompts (Positive, Negative Points and Bounding Boxes) are supported.

- Two SAM2 buttons are available: SAM2_one (faster) for the slices where prompts are given, SAM2 for all slices via propagation.

## Next steps

- Sync with the recent Cornerstone 2.0 update and OHIF -> Better segmentation experience

- Support multi-labels in segmentation

- Support save renamed and manually edited segmentation

## (potential) FAQ

- Q: Load library (libnvidia-ml.so) failed from NVIDIA Container Toolkit
- A: Run `sudo apt-get install --reinstall docker-ce ` [Reference](https://github.com/NVIDIA/nvidia-container-toolkit/issues/305)

- Q: `Failed to initialize NVML: Unknown Error` Or `No CUDA available``
- A: Edit `no-cgroups = false`in `/etc/nvidia-container-runtime/config.toml` [Reference](https://forums.developer.nvidia.com/t/nvida-container-toolkit-failed-to-initialize-nvml-unknown-error/286219/2)
