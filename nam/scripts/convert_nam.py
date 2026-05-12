#!/usr/bin/env python3
# ─── NAM Model Converter ──────────────────────────────
# Converts Neural Amp Modeler .nam models to YAWN binary format.
#
# Usage: python3 convert_nam.py model.nam output.yawn
#
# The .nam file is a directory containing:
#   config.json   — model architecture
#   weights/      — numpy .npy files for each layer

import json
import struct
import sys
import numpy as np
from pathlib import Path

def load_nam_model(nam_path):
    """Load a NAM .nam model directory"""
    nam_dir = Path(nam_path)
    if not nam_dir.is_dir():
        raise FileNotFoundError(f"Not a directory: {nam_path}")
    
    config_path = nam_dir / "config.json"
    if not config_path.exists():
        raise FileNotFoundError(f"No config.json in {nam_path}")
    
    with open(config_path) as f:
        config = json.load(f)
    
    weights_dir = nam_dir / "weights"
    
    return config, weights_dir

def load_conv1d(weights_dir, prefix):
    """Load Conv1D weights from numpy files"""
    weight = np.load(weights_dir / f"{prefix}.weight.npy")
    bias = np.load(weights_dir / f"{prefix}.bias.npy")
    return weight.astype(np.float32), bias.astype(np.float32)

def write_conv1d(f, weight, bias, dilation=1):
    """Write Conv1D weights in binary format"""
    out_channels, in_channels, kernel_size = weight.shape
    
    f.write(struct.pack('iii', in_channels, out_channels, kernel_size))
    f.write(struct.pack('i', dilation))
    
    # Flatten and write weights: [outCh][inCh][kernelSize]
    f.write(weight.tobytes())
    f.write(bias.tobytes())

def convert_model(nam_path, output_path):
    """Convert NAM model to YAWN binary format"""
    config, weights_dir = load_nam_model(nam_path)
    
    # Extract architecture
    arch = config.get("architecture", {})
    num_blocks = arch.get("num_blocks", 8)
    channels = arch.get("channels", 16)
    
    # Extract metadata
    metadata = config.get("metadata", {})
    sample_rate = metadata.get("sample_rate", 48000.0)
    name = metadata.get("name", Path(nam_path).name)
    loudness = 1.0
    
    # Try to get loudness from config
    loudness = config.get("loudness", 1.0)
    
    with open(output_path, 'wb') as f:
        # Header
        f.write(struct.pack('i', 1))          # inputChannels
        f.write(struct.pack('i', channels))   # channels
        f.write(struct.pack('i', num_blocks)) # numBlocks
        f.write(struct.pack('d', sample_rate))
        f.write(struct.pack('f', loudness))
        
        # Name
        name_bytes = name.encode('utf-8')
        f.write(struct.pack('i', len(name_bytes)))
        f.write(name_bytes)
        
        # Input convolution: 1 -> channels, kernel=3
        try:
            w, b = load_conv1d(weights_dir, "net._input_conv")
        except FileNotFoundError:
            try:
                w, b = load_conv1d(weights_dir, "input_conv")
            except FileNotFoundError:
                # Try recursive layer names
                w, b = load_conv1d(weights_dir, "_net._input_conv")
        
        write_conv1d(f, w, b, dilation=1)
        
        # Dilated blocks
        dilations = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512]
        
        for block_idx in range(num_blocks):
            dilation = dilations[min(block_idx, len(dilations) - 1)]
            
            # Block convolutions
            for conv_name in ["filter", "gate", "mix"]:
                try:
                    w, b = load_conv1d(
                        weights_dir,
                        f"net._blocks.{block_idx}._{conv_name}_conv"
                    )
                except FileNotFoundError:
                    try:
                        w, b = load_conv1d(
                            weights_dir,
                            f"blocks.{block_idx}.{conv_name}_conv"
                        )
                    except FileNotFoundError:
                        try:
                            w, b = load_conv1d(
                                weights_dir,
                                f"_net._blocks.{block_idx}._{conv_name}_conv"
                            )
                        except FileNotFoundError as e:
                            print(f"Warning: missing {conv_name} weights for block {block_idx}")
                            raise e
                
                conv_dilation = dilation if conv_name != "mix" else 1
                write_conv1d(f, w, b, dilation=conv_dilation)
        
        # Head convolution: channels -> 1
        try:
            w, b = load_conv1d(weights_dir, "net._head_conv")
        except FileNotFoundError:
            try:
                w, b = load_conv1d(weights_dir, "head_conv")
            except FileNotFoundError:
                w, b = load_conv1d(weights_dir, "_net._head_conv")
        
        write_conv1d(f, w, b, dilation=1)
    
    print(f"Converted {nam_path} → {output_path}")
    print(f"  Channels: {channels}, Blocks: {num_blocks}")
    print(f"  Sample rate: {sample_rate} Hz")
    print(f"  Size: {Path(output_path).stat().st_size / 1024:.1f} KB")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 convert_nam.py <model.nam> <output.yawn>")
        sys.exit(1)
    
    convert_model(sys.argv[1], sys.argv[2])
