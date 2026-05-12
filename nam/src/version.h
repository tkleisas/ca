#pragma once

#include <string>

namespace yawn {

constexpr const char* VERSION = "1.0.0";
constexpr const char* PLUGIN_NAME = "YAWN";
constexpr const char* VENDOR = "gn01stic";
constexpr const char* URL = "https://gn01stic.gr";
constexpr const char* EMAIL = "admin@gn01stic.gr";

// ─── VST3 Identifiers ─────────────────────────────────

// MUST be a valid GUID — generate with: python3 -c "import uuid; print(str(uuid.uuid4()))"
constexpr const char* PROCESSOR_UID = "43accae2-6b52-4ba2-8480-cf78d56c1cda";
constexpr const char* CONTROLLER_UID = "c465494c-1bff-4485-8fde-0371a5203c6f";

} // namespace yawn
