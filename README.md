# OHIF-SAM2

[Paper](https://www.techrxiv.org/users/868002/articles/1248561-ohif-sam2-accelerating-radiology-workflows-with-segment-anything-model-2)

## Prerequisite

- Install Docker, NVIDIA Container Toolkit

- tested version: Docker: 27.3.1, NVIDIA Container Toolkit: 1.16.2, CUDA Version: 12.6

## Getting Started

- Run `bash start.sh`
- Go to http://localhost:1026
- Upload all DICOM files in sample-data

## Demo Video

[![OHIF-SAM2 Demo](https://img.youtube.com/vi/oNDI-WBMWC0/0.jpg)](https://youtu.be/oNDI-WBMWC0)

- Prompts (Positive, Negative Points and Bounding Boxes) are supported.

- Two SAM2 buttons are available: SAM2_one (faster) for the slices where prompts are given, SAM2 for all slices via propagation.

- Multiple labels are supported - click nextObj button once it is done with the current label

## Updates

- OHIF upgrade: 3.10-beta.48, cornerstone 2.0 -> Support partially 3D segmentation rendering

- Fixed flipping segmentation issue

## Next steps

- Support SAM2 for any label anytime: Currently, if a user pass to the next Obj, the user cannot reuse SAM2 for the old label, only manually edit

- Integrate Text prompt

## (potential) FAQ

- Q: Load library (libnvidia-ml.so) failed from NVIDIA Container Toolkit
- A: Run `sudo apt-get install --reinstall docker-ce ` [Reference](https://github.com/NVIDIA/nvidia-container-toolkit/issues/305)

- Q: `Failed to initialize NVML: Unknown Error` Or `No CUDA available``
- A: Edit `no-cgroups = false`in `/etc/nvidia-container-runtime/config.toml` [Reference](https://forums.developer.nvidia.com/t/nvida-container-toolkit-failed-to-initialize-nvml-unknown-error/286219/2)

## How to Cite

```bibtex
@article{jcho2024ohifsam2,
  title={OHIF-SAM2: Accelerating Radiology Workflows with Segment Anything Model 2},
  author={Cho, Jaeyoung and Liu, Jingyu and Schlamp, Kai and Rastogi, Aditya and Vollmuth, Philipp},
  journal={TechRxiv preprint techrxiv.173387978.85520380},
  url={https://www.techrxiv.org/users/868002/articles/1248561-ohif-sam2-accelerating-radiology-workflows-with-segment-anything-model-2},
  year={2024}
}
```
