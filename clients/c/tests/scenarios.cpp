// The C++ twin of scenarios.c: the same output line, with failures arriving
// as novamem::Error through novamem.hpp.
#include <cstdlib>
#include <iostream>
#include <string>

#include "novamem.hpp"

int main(int argc, char **argv) {
    if (argc != 6) {
        std::cerr << "usage: " << argv[0] << " base token timeout_ms method args_json\n";
        return 2;
    }
    const std::string base = argv[1], token = argv[2], method = argv[4], args = argv[5];
    const auto timeout = static_cast<uint32_t>(std::strtoul(argv[3], nullptr, 10));
    try {
        std::string result = "null";
        if (method == "ctor") {
            novamem::Client c(base, token, std::chrono::milliseconds(timeout));
        } else {
            result = novamem::test_call(base, token, timeout, method, args);
        }
        const bool empty = result == "[]" || result.find("\"results\":[]") != std::string::npos;
        std::cout << (empty ? "empty" : "ok") << " 0 0 - " << result << "\n";
    } catch (const novamem::Error &e) {
        const char *o = e.unavailable ? "unavailable" : e.not_found ? "not_found" : "error";
        std::cout << o << " " << (e.retryable ? 1 : 0) << " " << e.status_code << " " << (e.code.empty() ? "-" : e.code)
                  << " " << e.message << "\n";
    }
    return 0;
}
