#pragma once

#include "public.sdk/source/vst/vstaudioeffect.h"
#include "nam_model.h"
#include "param_ids.h"

#include <memory>

namespace yawn {

// ─── YAWN Audio Processor ────────────────────────────

class YawnProcessor : public Steinberg::Vst::AudioEffect {
public:
    YawnProcessor();
    ~YawnProcessor() override;

    // ─── AudioEffect overrides ────────────────────────
    
    Steinberg::tresult PLUGIN_API initialize(
        Steinberg::FUnknown* context) override;
    
    Steinberg::tresult PLUGIN_API terminate() override;
    
    Steinberg::tresult PLUGIN_API setBusArrangements(
        Steinberg::Vst::SpeakerArrangement* inputs,
        int32 numIns,
        Steinberg::Vst::SpeakerArrangement* outputs,
        int32 numOuts) override;
    
    Steinberg::tresult PLUGIN_API setupProcessing(
        Steinberg::Vst::ProcessSetup& setup) override;
    
    Steinberg::tresult PLUGIN_API setActive(Steinberg::TBool state) override;
    
    Steinberg::tresult PLUGIN_API process(
        Steinberg::Vst::ProcessData& data) override;
    
    Steinberg::tresult PLUGIN_API setState(
        Steinberg::IBStream* state) override;
    
    Steinberg::tresult PLUGIN_API getState(
        Steinberg::IBStream* state) override;
    
    Steinberg::tresult PLUGIN_API canProcessSampleSize(
        int32 symbolicSampleSize) override;

    // ─── Plugin interface ─────────────────────────────
    
    static Steinberg::FUnknown* createInstance(void* /*context*/) {
        return static_cast<Steinberg::Vst::IAudioProcessor*>(
            new YawnProcessor());
    }

private:
    std::unique_ptr<NamModel> m_model;
    double m_sampleRate = 48000.0;
    float m_params[kNumParams] = {};
    
    // Smooth parameter interpolation
    float m_currentInputGain = 0.0f;
    float m_currentOutputLevel = 0.0f;
    float m_currentTone = 0.5f;
    
    // Tone state tracking (to detect changes)
    float m_lastToneApplied = -1.0f;
    float m_pendingTone = 0.5f;
    
    static constexpr double kSmoothTime = 0.005; // 5ms smoothing
    double m_smoothCoeff = 0.0;
};

} // namespace yawn
