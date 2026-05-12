#pragma once

namespace yawn {

// ─── Parameter IDs ───────────────────────────────────

enum ParamTag : uint32_t {
    kParamInputGain = 0,
    kParamOutputLevel,
    kParamTone,
    kParamModelSelect,
    kParamBypass,
    kNumParams
};

// Parameter metadata
struct ParamInfo {
    uint32_t id;
    const char* name;
    const char* units;
    double defaultValue;
    double minValue;
    double maxValue;
    double stepCount;  // 0 = continuous, N = N+1 discrete steps
};

constexpr ParamInfo kParamInfos[] = {
    { kParamInputGain,  "Input Gain",  "dB",  0.0, -24.0, 24.0, 0 },
    { kParamOutputLevel,"Output Level","dB",  0.0, -24.0, 24.0, 0 },
    { kParamTone,       "Tone",         "",   0.5,   0.0,  1.0, 0 },
    { kParamModelSelect,"Model",        "",   0.0,   0.0,  0.0, 0 },
    { kParamBypass,     "Bypass",       "",   0.0,   0.0,  1.0, 1 },
};

static_assert(sizeof(kParamInfos) / sizeof(kParamInfos[0]) == kNumParams,
              "ParamInfo array must match ParamTag count");

} // namespace yawn
