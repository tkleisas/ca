#include "controller.h"
#include "version.h"

namespace yawn {

// ─── YawnController Implementation ────────────────────

YawnController::YawnController() = default;
YawnController::~YawnController() = default;

tresult PLUGIN_API YawnController::initialize(FUnknown* context) {
    tresult result = EditController::initialize(context);
    if (result != kResultOk) return result;

    // Register all parameters
    for (int i = 0; i < kNumParams; ++i) {
        parameters.addParameter(
            STR16(kParamInfos[i].name),
            STR16(kParamInfos[i].units),
            static_cast<int32>(kParamInfos[i].stepCount),
            kParamInfos[i].defaultValue,
            Steinberg::Vst::ParameterInfo::kCanAutomate,
            kParamInfos[i].id
        );
    }

    return kResultOk;
}

tresult PLUGIN_API YawnController::terminate() {
    return EditController::terminate();
}

tresult PLUGIN_API YawnController::setParamNormalized(ParamID tag, ParamValue value) {
    // Update UI if we had one
    return EditController::setParamNormalized(tag, value);
}

} // namespace yawn
