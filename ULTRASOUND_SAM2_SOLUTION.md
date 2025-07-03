# Ultrasound SAM2 Segmentation Solution Guide

## Problem Analysis

Your SAM2 segmentation works for CT/MRI but fails for ultrasound due to:

1. **Domain Gap**: SAM2 wasn't trained specifically for ultrasound characteristics
2. **Multiframe Processing**: Ultrasound multiframe DICOMs may be processed differently
3. **Image Properties**: Ultrasound has unique noise patterns and contrast that differ from CT/MRI

## Solution 1: Multiframe to Single-Frame Conversion (Immediate)

### Step 1: Install Dependencies
```bash
pip install -r converter_requirements.txt
```

### Step 2: Convert Your Multiframe DICOM
```bash
# Convert a single multiframe DICOM file
python multiframe_to_single_converter.py your_ultrasound.dcm output_directory/

# Convert all DICOMs in a directory
python multiframe_to_single_converter.py input_directory/ output_directory/ --recursive
```

### Step 3: Test with OHIF-SAM2
1. Load the converted single-frame DICOMs into your OHIF viewer
2. Try SAM2 segmentation on individual frames
3. Compare results with your CT/MRI segmentation performance

## Solution 2: Ultrasound-Specific SAM2 Fine-tuning (Long-term)

Based on recent research, consider implementing ultrasound-specific adaptations:

### Option A: Use Pre-trained Ultrasound Models
- **UltraSam**: Fine-tuned SAM for ultrasound (available on GitHub)
- **ClickSAM**: Specifically designed for ultrasound click prompts
- **SonoSAMTrack**: For ultrasound segmentation and tracking

### Option B: Fine-tune Your SAM2 for Ultrasound
1. Collect ultrasound segmentation datasets
2. Fine-tune SAM2 specifically on ultrasound images
3. Implement domain-specific preprocessing

## Implementation in Your OHIF-SAM2 System

### Modify Your SAM2 Integration

Looking at your current implementation in `Viewers/extensions/default/src/commandsModule.ts`, you can add ultrasound-specific preprocessing:

```typescript
// Add ultrasound detection and preprocessing
async function preprocessUltrasoundImage(imageData, modality) {
  if (modality === 'US') {
    // Apply ultrasound-specific preprocessing
    // - Noise reduction
    // - Contrast enhancement
    // - Domain-specific normalization
    return enhancedImageData;
  }
  return imageData;
}

// Modify your sam2_one and sam2 functions
async sam2_one() {
  // ... existing code ...
  
  // Detect if current image is ultrasound
  const modality = currentDisplaySets.Modality;
  
  if (modality === 'US') {
    // Use ultrasound-specific parameters
    params.ultrasound_mode = true;
    params.preprocessing = 'ultrasound';
  }
  
  // ... rest of function ...
}
```

### Add Ultrasound-Specific Configuration

In your MONAI Label backend, add ultrasound handling:

```python
# In your segmentation inference
def preprocess_ultrasound(image):
    """Apply ultrasound-specific preprocessing"""
    # Noise reduction
    # Contrast enhancement
    # Normalization for ultrasound domain
    return processed_image

def run_sam2_inference(image, modality, **kwargs):
    if modality == 'US':
        image = preprocess_ultrasound(image)
        # Use ultrasound-specific model parameters
    
    return sam2_model.predict(image, **kwargs)
```

## Testing Strategy

1. **Start with Single-Frame Conversion**: This will quickly tell you if the issue is multiframe handling
2. **Compare Performance**: Test the same ultrasound anatomy with single frames vs. multiframe
3. **Evaluate Results**: If single frames work better, the issue was multiframe processing
4. **If Still Poor**: The issue is ultrasound domain adaptation, requiring Solution 2

## Expected Outcomes

### If Multiframe Conversion Helps:
- You'll see improved segmentation quality
- Confirms the issue was multiframe processing
- Can proceed with this approach as interim solution

### If Conversion Doesn't Help:
- The issue is ultrasound-specific domain gap
- Need to implement ultrasound-adapted SAM2
- Consider using specialized ultrasound segmentation models

## Next Steps

1. **Try the conversion script** on your multiframe ultrasound DICOMs
2. **Test segmentation** on the converted single frames
3. **Report back** on whether this improves performance
4. **If successful**: Consider implementing automatic multiframe detection and conversion
5. **If unsuccessful**: We'll move to ultrasound-specific model fine-tuning

## Additional Resources

- [UltraSam Paper](https://arxiv.org/abs/2411.16222) - Foundation model for ultrasound
- [ClickSAM Paper](https://arxiv.org/abs/2402.05902) - Click-based ultrasound segmentation
- [SonoSAMTrack](https://arxiv.org/abs/2310.16872) - Ultrasound tracking with SAM

This approach addresses your immediate need while providing a path toward a more robust long-term solution. 