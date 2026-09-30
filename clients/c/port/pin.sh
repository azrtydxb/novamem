#!/bin/sh
# Points the vcpkg port and Conan recipe at a release's archives:
#
#   sh clients/c/port/pin.sh <version> <sha512 linux-x86_64> <sha512 linux-aarch64>
#
# release-sdk-c.yml runs it after the GitHub release exists. Each value
# sits on a line tagged with a "pin:" comment, so nothing else is touched.
set -eu
[ $# -eq 3 ] || {
	echo "usage: pin.sh <version> <sha512 x86_64> <sha512 aarch64>" >&2
	exit 2
}
cd "$(dirname "$0")"
v=$1 x86=$2 arm=$3
for h in "$x86" "$arm"; do
	echo "$h" | grep -Eq '^[0-9a-f]{128}$' || {
		echo "not a SHA-512: $h" >&2
		exit 2
	}
done
sed -i.bak \
	-e "s/^\(set(NOVAMEM_VERSION \"\)[^\"]*\(\")  # pin:version\)$/\1$v\2/" \
	-e "s/^\(    set(SHA512 \"\)[^\"]*\(\")  # pin:linux-x86_64\)$/\1$x86\2/" \
	-e "s/^\(    set(SHA512 \"\)[^\"]*\(\")  # pin:linux-aarch64\)$/\1$arm\2/" \
	vcpkg/portfile.cmake
sed -i.bak -e "s/^\(  \"version\": \"\)[^\"]*\(\",\)$/\1$v\2/" vcpkg/vcpkg.json
sed -i.bak \
	-e "s/^\(    version = \"\)[^\"]*\(\"  # pin:version\)$/\1$v\2/" \
	-e "s/^\(    \"x86_64\": \"\)[^\"]*\(\",  # pin:linux-x86_64\)$/\1$x86\2/" \
	-e "s/^\(    \"armv8\": \"\)[^\"]*\(\",  # pin:linux-aarch64\)$/\1$arm\2/" \
	conan/conanfile.py
rm -f vcpkg/portfile.cmake.bak vcpkg/vcpkg.json.bak conan/conanfile.py.bak
# Every pin must have landed. A line whose shape drifted makes its sed
# expression match nothing, silently keeping the old version or hash —
# so each expected line is checked exactly, not just for "unpinned".
missing=0
expect() {
	grep -qxF -- "$2" "$1" || {
		echo "pin.sh: $1 has no line: $2" >&2
		missing=1
	}
}
expect vcpkg/portfile.cmake "set(NOVAMEM_VERSION \"$v\")  # pin:version"
expect vcpkg/portfile.cmake "    set(SHA512 \"$x86\")  # pin:linux-x86_64"
expect vcpkg/portfile.cmake "    set(SHA512 \"$arm\")  # pin:linux-aarch64"
expect vcpkg/vcpkg.json "  \"version\": \"$v\","
expect conan/conanfile.py "    version = \"$v\"  # pin:version"
expect conan/conanfile.py "    \"x86_64\": \"$x86\",  # pin:linux-x86_64"
expect conan/conanfile.py "    \"armv8\": \"$arm\",  # pin:linux-aarch64"
exit $missing
