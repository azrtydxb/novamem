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
# Every pin must have landed: a recipe that still says "unpinned" would
# publish a hash check that can never pass.
if grep -n "unpinned.*# pin:" vcpkg/portfile.cmake conan/conanfile.py; then
	echo "pin.sh: a pin line did not match" >&2
	exit 1
fi
