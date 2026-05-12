# ─── YAWN — Neural Amp Modeler VST3 Plugin ─────────────
# CMake build system
# Dependencies: VST3 SDK, RTNeural (header-only), Eigen

cmake_minimum_required(VERSION 3.20)
project(yawn VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ─── Options ──────────────────────────────────────────

option(VST3_SDK_DIR "Path to Steinberg VST3 SDK" OFF)
option(USE_RTNEURAL "Use RTNeural for inference (header-only)" ON)

# ─── VST3 SDK ─────────────────────────────────────────

if(NOT VST3_SDK_DIR)
    if(DEFINED ENV{VST3_SDK_DIR})
        set(VST3_SDK_DIR "$ENV{VST3_SDK_DIR}")
    else()
        set(VST3_SDK_DIR "${CMAKE_SOURCE_DIR}/deps/vst3sdk" CACHE PATH "VST3 SDK path")
    endif()
endif()

if(NOT EXISTS "${VST3_SDK_DIR}/CMakeLists.txt")
    message(STATUS "VST3 SDK not found at ${VST3_SDK_DIR}")
    message(STATUS "Clone with: git clone --recursive https://github.com/steinbergmedia/vst3sdk.git deps/vst3sdk")
    message(FATAL_ERROR "VST3 SDK required. Set VST3_SDK_DIR or clone to deps/vst3sdk")
endif()

# Don't build VST3 SDK examples/tests - we just need the headers + base libs
set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "")
set(SMTG_RUN_VST_VALIDATOR OFF CACHE BOOL "")
add_subdirectory(${VST3_SDK_DIR} deps/vst3sdk)

# ─── Eigen (for RTNeural) ─────────────────────────────

find_package(Eigen3 QUIET)
if(NOT Eigen3_FOUND)
    include(FetchContent)
    FetchContent_Declare(
        eigen
        GIT_REPOSITORY https://gitlab.com/libeigen/eigen.git
        GIT_TAG 3.4.0
    )
    FetchContent_MakeAvailable(eigen)
    set(EIGEN3_INCLUDE_DIR "${eigen_SOURCE_DIR}")
endif()

# ─── RTNeural (header-only) ───────────────────────────

if(USE_RTNEURAL)
    include(FetchContent)
    FetchContent_Declare(
        rtneural
        GIT_REPOSITORY https://github.com/jatinchowdhury18/RTNeural.git
        GIT_TAG master
    )
    FetchContent_GetProperties(rtneural)
    if(NOT rtneural_POPULATED)
        FetchContent_Populate(rtneural)
    endif()
    set(RTNEURAL_INCLUDE_DIR "${rtneural_SOURCE_DIR}")
endif()

# ─── Plugin Sources ───────────────────────────────────

set(YAWN_SOURCES
    src/entry.cpp
    src/processor.cpp
    src/controller.cpp
    src/nam_model.cpp
    src/wavenet.cpp
    src/param_ids.h
    src/processor.h
    src/controller.h
    src/nam_model.h
    src/wavenet.h
    src/version.h
)

# ─── Plugin Library ───────────────────────────────────

add_library(yawn SHARED ${YAWN_SOURCES})

target_include_directories(yawn PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${EIGEN3_INCLUDE_DIR}
    ${RTNEURAL_INCLUDE_DIR}
)

target_link_libraries(yawn PRIVATE
    sdk_common
    sdk
    pluginterfaces
    base
)

if(MSVC)
    target_compile_definitions(yawn PRIVATE _USE_MATH_DEFINES)
endif()

# ─── VST3 target properties ───────────────────────────

set_target_properties(yawn PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/VST3/yawn.vst3/Contents/x86_64-linux"
    PREFIX ""
    SUFFIX ".so"
)

if(APPLE)
    set_target_properties(yawn PROPERTIES
        LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/VST3/yawn.vst3/Contents/MacOS"
        SUFFIX ""
    )
endif()
