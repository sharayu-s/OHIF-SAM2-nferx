#!/usr/bin/env python3
"""
Convert multiframe DICOM ultrasound images to single-frame DICOM images.
This script helps with SAM2 segmentation issues by creating individual DICOM files for each frame.
"""

import os
import pydicom
import argparse
import numpy as np
from pathlib import Path
import logging

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
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
        # Check if pixel data is compressed
        if hasattr(ds, 'file_meta') and hasattr(ds.file_meta, 'TransferSyntaxUID'):
            transfer_syntax = ds.file_meta.TransferSyntaxUID
            if transfer_syntax in ['1.2.840.10008.1.2.4.90', '1.2.840.10008.1.2.4.91']:  # JPEG 2000
                logger.warning("JPEG 2000 compressed data detected. May need special handling.")
        
        # Handle different pixel data formats
        if hasattr(ds, 'PixelData'):
            # Calculate frame size
            rows = ds.Rows
            cols = ds.Columns
            samples_per_pixel = getattr(ds, 'SamplesPerPixel', 1)
            bits_allocated = ds.BitsAllocated
            
            # Calculate bytes per frame
            if bits_allocated == 1:  # Binary data
                frame_size_bits = rows * cols * samples_per_pixel
                frame_size_bytes = (frame_size_bits + 7) // 8  # Round up to nearest byte
            else:
                bytes_per_pixel = bits_allocated // 8
                frame_size_bytes = rows * cols * samples_per_pixel * bytes_per_pixel
            
            # Extract frame data
            start_byte = frame_num * frame_size_bytes
            end_byte = start_byte + frame_size_bytes
            
            if end_byte > len(ds.PixelData):
                logger.error(f"Frame {frame_num} extends beyond available pixel data")
                return None
                
            return ds.PixelData[start_byte:end_byte]
            
        elif hasattr(ds, 'pixel_array'):
            # Use pydicom's pixel_array if available
            pixel_array = ds.pixel_array
            if len(pixel_array.shape) > 2:  # Multi-frame
                frame_data = pixel_array[frame_num]
                return frame_data.tobytes()
            
    except Exception as e:
        logger.error(f"Error extracting pixel data for frame {frame_num}: {e}")
        return None
    
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
    
    Args:
        input_path (str): Path to the multiframe DICOM file
        output_dir (str): Directory to save single-frame DICOM files
    """
    try:
        # Read the multiframe DICOM
        logger.info(f"Reading DICOM file: {input_path}")
        ds = pydicom.dcmread(input_path)
        
        # Check if it's actually multiframe
        if not hasattr(ds, 'NumberOfFrames') or ds.NumberOfFrames <= 1:
            logger.info(f"File {input_path} is not multiframe or has only 1 frame")
            return False
        
        # Create output directory if it doesn't exist
        os.makedirs(output_dir, exist_ok=True)
        
        # Get base filename without extension
        base_filename = Path(input_path).stem
        
        logger.info(f"Converting {ds.NumberOfFrames} frames from {input_path}")
        logger.info(f"Image dimensions: {ds.Rows}x{ds.Columns}, Bits: {ds.BitsAllocated}")
        
        # Check for ultrasound modality
        is_ultrasound = hasattr(ds, 'Modality') and ds.Modality == 'US'
        if is_ultrasound:
            logger.info("Detected ultrasound modality - applying US-specific processing")
        
        # Extract each frame
        successful_frames = 0
        for frame_num in range(ds.NumberOfFrames):
            try:
                # Create a copy of the original dataset
                single_frame_ds = ds.copy()
                
                # Modify for single frame
                single_frame_ds.NumberOfFrames = 1
                
                # Extract pixel data for this frame
                frame_pixel_data = extract_frame_pixel_data(ds, frame_num)
                if frame_pixel_data is None:
                    logger.error(f"Failed to extract pixel data for frame {frame_num}")
                    continue
                
                single_frame_ds.PixelData = frame_pixel_data
                
                # Update frame-specific metadata
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
                
                # Remove multiframe-specific attributes
                multiframe_attrs = [
                    'PerFrameFunctionalGroupsSequence',
                    'SharedFunctionalGroupsSequence'
                ]
                
                for attr in multiframe_attrs:
                    if hasattr(single_frame_ds, attr):
                        # Apply shared groups before removing
                        if attr == 'SharedFunctionalGroupsSequence':
                            shared_groups = getattr(single_frame_ds, attr)
                            for group_name, group_data in shared_groups.items():
                                if hasattr(group_data, '__iter__') and not isinstance(group_data, str):
                                    for item in group_data:
                                        for elem in item:
                                            try:
                                                setattr(single_frame_ds, elem.keyword, elem.value)
                                            except:
                                                pass
                        
                        delattr(single_frame_ds, attr)
                
                # Update Instance Number
                single_frame_ds.InstanceNumber = frame_num + 1
                
                # Generate new SOP Instance UID for each frame
                single_frame_ds.SOPInstanceUID = pydicom.uid.generate_uid()
                
                # Preserve ultrasound-specific metadata
                if is_ultrasound:
                    preserve_ultrasound_metadata(single_frame_ds, ds, frame_num)
                
                # Save single frame DICOM
                output_filename = f"{base_filename}_frame_{frame_num + 1:04d}.dcm"
                output_path = os.path.join(output_dir, output_filename)
                
                single_frame_ds.save_as(output_path)
                successful_frames += 1
                logger.debug(f"Saved frame {frame_num + 1} to {output_path}")
                
            except Exception as e:
                logger.error(f"Error processing frame {frame_num}: {e}")
                continue
        
        logger.info(f"Successfully converted {successful_frames}/{ds.NumberOfFrames} frames")
        return successful_frames > 0
        
    except Exception as e:
        logger.error(f"Error processing file {input_path}: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description='Convert multiframe DICOM to single-frame DICOMs')
    parser.add_argument('input', help='Input multiframe DICOM file or directory')
    parser.add_argument('output', help='Output directory for single-frame DICOMs')
    parser.add_argument('--recursive', '-r', action='store_true', help='Process directory recursively')
    parser.add_argument('--verbose', '-v', action='store_true', help='Enable verbose logging')
    
    args = parser.parse_args()
    
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    
    input_path = Path(args.input)
    output_path = Path(args.output)
    
    if input_path.is_file():
        # Single file conversion
        success = convert_multiframe_to_single_frames(str(input_path), str(output_path))
        if success:
            logger.info("Conversion completed successfully")
        else:
            logger.error("Conversion failed")
            return 1
            
    elif input_path.is_dir():
        # Directory conversion
        dicom_files = []
        if args.recursive:
            dicom_files = list(input_path.rglob('*.dcm'))
        else:
            dicom_files = list(input_path.glob('*.dcm'))
        
        if not dicom_files:
            logger.error("No DICOM files found in the specified directory")
            return 1
        
        successful_conversions = 0
        for dicom_file in dicom_files:
            # Create subdirectory for each multiframe file
            relative_path = dicom_file.relative_to(input_path)
            file_output_dir = output_path / relative_path.parent / relative_path.stem
            
            logger.info(f"Processing {dicom_file}")
            if convert_multiframe_to_single_frames(str(dicom_file), str(file_output_dir)):
                successful_conversions += 1
        
        logger.info(f"Successfully processed {successful_conversions}/{len(dicom_files)} files")
        
    else:
        logger.error(f"Error: {input_path} is not a valid file or directory")
        return 1
    
    return 0


if __name__ == "__main__":
    exit(main()) 