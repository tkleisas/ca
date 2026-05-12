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
constexpr const char* PROCESSOR_UID = "a1b2c3d4-5678-9abc-def0-123456789abc";
constexpr const char* CONTROLLER_UID = "b2c3d4e5-6789-abcd-ef01-234567890123";

} // namespace yawn
