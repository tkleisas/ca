#include "npy_loader.h"

#include <fstream>
#include <cstring>
#include <stdexcept>
#include <algorithm>
#include <iostream>

namespace yawn {
namespace npy {

NpyArray load(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) {
        throw std::runtime_error("Cannot open: " + path);
    }
    
    // ─── Read magic ───────────────────────────────────
    char magic[6];
    file.read(magic, 6);
    if (std::memcmp(magic, "\x93NUMPY", 6) != 0) {
        throw std::runtime_error("Not a .npy file: " + path);
    }
    
    // ─── Read version ─────────────────────────────────
    uint8_t major, minor;
    file.read(reinterpret_cast<char*>(&major), 1);
    file.read(reinterpret_cast<char*>(&minor), 1);
    
    // ─── Read header length (little-endian) ────────────
    uint16_t headerLen = 0;
    if (major == 1) {
        file.read(reinterpret_cast<char*>(&headerLen), 2);
    } else if (major >= 2) {
        uint32_t headerLen32 = 0;
        file.read(reinterpret_cast<char*>(&headerLen32), 4);
        headerLen = static_cast<uint16_t>(headerLen32);
    }
    
    // ─── Read header ──────────────────────────────────
    std::string header(headerLen, '\0');
    file.read(header.data(), headerLen);
    
    // Trim trailing whitespace
    while (!header.empty() && (header.back() == ' ' || header.back() == '\n')) {
        header.pop_back();
    }
    
    // ─── Parse header ─────────────────────────────────
    NpyArray result;
    result.fortranOrder = false;
    
    // Parse descr (dtype)
    auto descrPos = header.find("'descr'");
    if (descrPos != std::string::npos) {
        auto colonPos = header.find(":", descrPos);
        auto quote1 = header.find("'", colonPos);
        auto quote2 = header.find("'", quote1 + 1);
        std::string dtype = header.substr(quote1 + 1, quote2 - quote1 - 1);
        if (dtype != "<f4" && dtype != ">f4" && dtype != "f4") {
            throw std::runtime_error("Unsupported dtype: " + dtype + " in " + path);
        }
    }
    
    // Parse fortran_order
    if (header.find("True") != std::string::npos && 
        header.find("'fortran_order'") != std::string::npos) {
        // Find the value after fortran_order
        auto foPos = header.find("'fortran_order'");
        auto colon = header.find(":", foPos);
        if (header.find("True", colon) != std::string::npos) {
            result.fortranOrder = true;
        }
    }
    
    // Parse shape
    auto shapePos = header.find("'shape'");
    if (shapePos != std::string::npos) {
        auto paren1 = header.find("(", shapePos);
        auto paren2 = header.find(")", paren1);
        if (paren1 != std::string::npos && paren2 != std::string::npos) {
            std::string shapeStr = header.substr(paren1 + 1, paren2 - paren1 - 1);
            // Parse comma-separated ints
            size_t pos = 0;
            while (pos < shapeStr.length()) {
                // Skip whitespace
                while (pos < shapeStr.length() && shapeStr[pos] == ' ') pos++;
                if (pos >= shapeStr.length()) break;
                
                // Read number
                auto comma = shapeStr.find(",", pos);
                std::string numStr;
                if (comma == std::string::npos) {
                    numStr = shapeStr.substr(pos);
                    pos = shapeStr.length();
                } else {
                    numStr = shapeStr.substr(pos, comma - pos);
                    pos = comma + 1;
                }
                
                // Trim
                while (!numStr.empty() && numStr.back() == ' ') numStr.pop_back();
                while (!numStr.empty() && numStr.front() == ' ') numStr.erase(0, 1);
                
                if (!numStr.empty()) {
                    result.shape.push_back(std::stoi(numStr));
                }
            }
        }
    }
    
    // Calculate total elements
    size_t totalElements = 1;
    for (int dim : result.shape) {
        totalElements *= dim;
    }
    
    // ─── Read data ────────────────────────────────────
    result.data.resize(totalElements);
    file.read(reinterpret_cast<char*>(result.data.data()),
              totalElements * sizeof(float));
    
    return result;
}

} // namespace npy
} // namespace yawn
