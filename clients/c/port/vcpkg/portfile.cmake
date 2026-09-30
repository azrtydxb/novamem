# vcpkg port for the novamem C/C++ SDK: installs the prebuilt archive from
# the clients/c/vX.Y.Z GitHub release. The version and hashes below are
# rewritten by clients/c/port/pin.sh when release-sdk-c.yml publishes; until
# the first release the hashes say "unpinned", which vcpkg rejects loudly.
set(NOVAMEM_VERSION "0.1.0")  # pin:version

if(VCPKG_TARGET_IS_LINUX AND VCPKG_TARGET_ARCHITECTURE STREQUAL "x64")
    set(NOVAMEM_TRIPLET "linux-x86_64")
    set(SHA512 "unpinned")  # pin:linux-x86_64
elseif(VCPKG_TARGET_IS_LINUX AND VCPKG_TARGET_ARCHITECTURE STREQUAL "arm64")
    set(NOVAMEM_TRIPLET "linux-aarch64")
    set(SHA512 "unpinned")  # pin:linux-aarch64
else()
    message(FATAL_ERROR "novamem: prebuilt archives exist for linux-x86_64 and linux-aarch64 only")
endif()

set(NOVAMEM_ARCHIVE "novamem-c-${NOVAMEM_VERSION}-${NOVAMEM_TRIPLET}.tar.gz")
vcpkg_download_distfile(ARCHIVE
    URLS "https://github.com/azrtydxb/novamem/releases/download/clients%2Fc%2Fv${NOVAMEM_VERSION}/${NOVAMEM_ARCHIVE}"
    FILENAME "${NOVAMEM_ARCHIVE}"
    SHA512 "${SHA512}"
)
vcpkg_extract_source_archive(SOURCE_PATH ARCHIVE "${ARCHIVE}")

file(INSTALL "${SOURCE_PATH}/include/" DESTINATION "${CURRENT_PACKAGES_DIR}/include")
if(VCPKG_LIBRARY_LINKAGE STREQUAL "static")
    set(NOVAMEM_LIB "${SOURCE_PATH}/lib/libnovamem_ffi.a")
else()
    set(NOVAMEM_LIB "${SOURCE_PATH}/lib/libnovamem_ffi.so")
endif()
# One optimised build serves both configurations: it is a prebuilt Rust library.
file(INSTALL "${NOVAMEM_LIB}" DESTINATION "${CURRENT_PACKAGES_DIR}/lib")
file(INSTALL "${NOVAMEM_LIB}" DESTINATION "${CURRENT_PACKAGES_DIR}/debug/lib")
file(WRITE "${CURRENT_PACKAGES_DIR}/share/${PORT}/copyright"
    "Apache-2.0. See https://github.com/azrtydxb/novamem\n")
