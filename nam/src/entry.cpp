#include "public.sdk/source/vst/vstinit.h"
#include "public.sdk/source/main/pluginfactoryvst3.h"

#include "processor.h"
#include "controller.h"
#include "version.h"

using namespace Steinberg;
using namespace yawn;

// ─── VST3 Plugin Factory ─────────────────────────────

static const FUID kYawnProcessorUID(yawn::PROCESSOR_UID);
static const FUID kYawnControllerUID(yawn::CONTROLLER_UID);

DEF_CLASS_IID(YawnProcessor)
DEF_CLASS_IID(YawnController)

BEGIN_FACTORY_DEF(VENDOR, URL, EMAIL)
    DEF_CLASS2(
        INLINE_UID_FROM_FUID(kYawnProcessorUID),
        PClassInfo::kManyInstances,
        kVstAudioEffectClass,
        yawn::PLUGIN_NAME,
        Vst::kDistributable,
        Vst::PlugType::kFxDistortion,
        yawn::VERSION,
        kVstVersionString,
        YawnProcessor::createInstance
    )
    DEF_CLASS2(
        INLINE_UID_FROM_FUID(kYawnControllerUID),
        PClassInfo::kManyInstances,
        kVstComponentControllerClass,
        yawn::PLUGIN_NAME,
        0, // no category
        "", // no subcategory
        yawn::VERSION,
        kVstVersionString,
        YawnController::createInstance
    )
END_FACTORY
