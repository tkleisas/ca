#pragma once

#include <vector>
#include <string>
#include <cstdint>

namespace yawn {
namespace npy {

// ─── NPY Loader ──────────────────────────────────────
// Loads numpy .npy files directly in C++.
// Supports float32 arrays (dtype <f4).

// Load a .npy file and return float data + shape
struct NpyArray {
    std::vector<float> data;
    std::vector<int> shape;  // e.g. {16, 1, 3} for Conv1D weights
    bool fortranOrder = false;
};

NpyArray load(const std::string& path);

// Load as flat float vector (ignoring shape)
inline std::vector<float> loadFlat(const std::string& path) {
    return load(path).data;
}

} // namespace npy
} // namespace yawn
