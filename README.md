# OHIF-SAM2

## Getting Started

- [Download sam2 models](https://github.com/facebookresearch/sam2?tab=readme-ov-file#download-checkpoints)
- Locate downloaded model at [`monai-label/checkpoints/`]
- Update ['L43, monai-label/monailabel/tasks/infer/basic_infer.py'] accordingly
- Run ['bash start.sh']

## Demo Video

[![OHIF-SAM2 Demo](https://raw.githubusercontent.com/CCI-Bonn/OHIF-SAM2/main/docs/videos/demo_v1_thumb.png)](https://raw.githubusercontent.com/CCI-Bonn/OHIF-SAM2/main/docs/videos/demo_v1.mov)

- Prompts (Positive, negative points and Bounding boxes) are supported.
- Two SAM2 buttons are available: SAM2_one (faster) for the slices where prompts are given, SAM2 for all slices via propagation.