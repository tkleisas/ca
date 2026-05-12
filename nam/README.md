# YAWN — Neural Amp Modeler VST3 Plugin

Guitar amplifier emulation using [Neural Amp Modeler](https://github.com/sdatkinson/NeuralAmpModeler).

## Build

```bash
# Clone with VST3 SDK
git clone --recursive https://github.com/steinbergmedia/vst3sdk.git deps/vst3sdk

# Build
cmake -B build
cmake --build build

# Install (Linux)
cp build/VST3/yawn.vst3 ~/.vst3/
```

## License

Same as Neural Amp Modeler.
