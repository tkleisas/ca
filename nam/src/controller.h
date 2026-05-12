#pragma once

#include "public.sdk/source/vst/vsteditcontroller.h"
#include "param_ids.h"

namespace yawn {

// ─── YAWN Edit Controller ────────────────────────────

class YawnController : public Steinberg::Vst::EditController {
public:
    YawnController();
    ~YawnController() override;

    tresult PLUGIN_API initialize(FUnknown* context) override;
    tresult PLUGIN_API terminate() override;

    // Parameter value change from UI
    tresult PLUGIN_API setParamNormalized(
        Steinberg::Vst::ParamID tag,
        Steinberg::Vst::ParamValue value) override;

    // Create plugin instance
    static FUnknown* createInstance(void* /*context*/) {
        return static_cast<Steinberg::Vst::IEditController*>(
            new YawnController());
    }
};

} // namespace yawn
