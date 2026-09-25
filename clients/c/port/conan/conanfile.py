"""Conan recipe for the novamem C/C++ SDK: the prebuilt archive from the
clients/c/vX.Y.Z GitHub release.

The version and hashes are rewritten by clients/c/port/pin.sh when
release-sdk-c.yml publishes; until the first release they say "unpinned",
and the hash check below refuses the download.
"""

import hashlib
import os

from conan import ConanFile
from conan.errors import ConanException, ConanInvalidConfiguration
from conan.tools.files import copy, download, unzip

SHA512 = {
    "x86_64": "unpinned",  # pin:linux-x86_64
    "armv8": "unpinned",  # pin:linux-aarch64
}
TRIPLET = {"x86_64": "linux-x86_64", "armv8": "linux-aarch64"}


class NovamemConan(ConanFile):
    name = "novamem"
    version = "0.1.0"  # pin:version
    license = "Apache-2.0"
    url = "https://github.com/azrtydxb/novamem"
    description = "C and C++ SDK for the novamem memory service (prebuilt)."
    settings = "os", "arch"
    # Conan reads these as class attributes; they are never mutated.
    options = {"shared": [True, False]}  # noqa: RUF012
    default_options = {"shared": False}  # noqa: RUF012

    def validate(self):
        if self.settings.os != "Linux" or str(self.settings.arch) not in TRIPLET:
            raise ConanInvalidConfiguration(
                "novamem: prebuilt archives exist for linux-x86_64 and linux-aarch64 only"
            )

    def build(self):
        arch = str(self.settings.arch)
        stage = f"novamem-c-{self.version}-{TRIPLET[arch]}"
        archive = f"{stage}.tar.gz"
        url = (
            "https://github.com/azrtydxb/novamem/releases/download/"
            f"clients%2Fc%2Fv{self.version}/{archive}"
        )
        download(self, url, archive)
        # conan.tools.files.get checks SHA-256 at most; the release pins SHA-512.
        with open(archive, "rb") as f:
            got = hashlib.sha512(f.read()).hexdigest()
        if got != SHA512[arch]:
            raise ConanException(
                f"novamem: {archive} SHA-512 is {got}, want {SHA512[arch]}"
            )
        unzip(self, archive, strip_root=True)

    def package(self):
        include = os.path.join(self.build_folder, "include")
        copy(self, "*.h", include, os.path.join(self.package_folder, "include"))
        copy(self, "*.hpp", include, os.path.join(self.package_folder, "include"))
        lib = "libnovamem_ffi.so" if self.options.shared else "libnovamem_ffi.a"
        copy(
            self,
            lib,
            os.path.join(self.build_folder, "lib"),
            os.path.join(self.package_folder, "lib"),
        )

    def package_info(self):
        self.cpp_info.libs = ["novamem_ffi"]
        self.cpp_info.system_libs = ["pthread", "dl", "m"]
