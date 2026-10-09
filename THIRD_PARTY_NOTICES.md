# Third-party notices

The native smolmux executable embeds Bun 1.4.0, OpenTUI, and their runtime
dependencies, and a release ships the companion executable `smolmux-zmx` beside
it. The release packaging process appends the exact license, author, and
patent notices shipped by the installed OpenTUI dependency packages for each
target platform to this file; the companion's notices are kept here by hand,
against the pinned commit in `companion.json`.

## Bun 1.4.0

Bun itself is MIT-licensed.

### JavaScriptCore

Bun statically links JavaScriptCore (and WebKit), which is LGPL-2 licensed.
WebCore files from WebKit are also licensed under LGPL2. Per LGPL2:

> If you statically link against an LGPL'd library, you must also provide your
> application in an object (not necessarily source) format, so that a user has
> the opportunity to modify the library and relink the application.

The patched WebKit used by Bun is available at
<https://github.com/oven-sh/webkit>. Instructions and sources for rebuilding
Bun 1.4.0 are available at <https://github.com/oven-sh/bun/tree/bun-v1.4.0>.

### Linked libraries

| Library | License |
| --- | --- |
| [BoringSSL](https://boringssl.googlesource.com/boringssl/) | [Several licenses](https://boringssl.googlesource.com/boringssl/+/refs/heads/master/LICENSE) |
| [Brotli](https://github.com/google/brotli) | MIT |
| [libarchive](https://github.com/libarchive/libarchive) | [Several licenses](https://github.com/libarchive/libarchive/blob/master/COPYING) |
| [lol-html](https://github.com/cloudflare/lol-html/tree/master/c-api) | BSD 3-Clause |
| [ls-hpack](https://github.com/litespeedtech/ls-hpack) | MIT |
| [ls-qpack](https://github.com/litespeedtech/ls-qpack) | MIT |
| [lsquic](https://github.com/litespeedtech/lsquic) | MIT and BSD 3-Clause |
| [mimalloc](https://github.com/microsoft/mimalloc) | MIT |
| [picohttpparser](https://github.com/h2o/picohttpparser) | Perl License or MIT |
| [zstd](https://github.com/facebook/zstd) | BSD or GPLv2 |
| [simdutf](https://github.com/simdutf/simdutf) | Apache 2.0 |
| [tinycc](https://github.com/tinycc/tinycc) | LGPL v2.1 |
| [uSockets](https://github.com/uNetworking/uSockets) | Apache 2.0 |
| [zlib-ng](https://github.com/zlib-ng/zlib-ng) | zlib |
| [c-ares](https://github.com/c-ares/c-ares) | MIT |
| [ICU](https://github.com/unicode-org/icu) | ICU license |
| [libbase64](https://github.com/aklomp/base64) | BSD 2-Clause |
| [libdeflate](https://github.com/ebiggers/libdeflate) | MIT |
| [libjpeg-turbo](https://github.com/libjpeg-turbo/libjpeg-turbo) | BSD 3-Clause, IJG, and zlib |
| [libspng](https://github.com/randy408/libspng) | BSD 2-Clause |
| [libwebp](https://github.com/webmproject/libwebp) | BSD 3-Clause |
| [highway](https://github.com/google/highway) | Apache 2.0 |
| [uucode](https://github.com/jacobsandlund/uucode) | MIT |
| [uWebSockets fork](https://github.com/jarred-sumner/uwebsockets) | Apache 2.0 |
| LLVM libc++abi `__cxa_thread_atexit` fallback | Apache 2.0 with LLVM exception |

### Embedded polyfills

Bun embeds compatibility polyfills from acorn, acorn-walk, assert,
browserify-zlib, buffer, constants-browserify, crypto-browserify,
domain-browser, events, https-browserify, os-browserify, path-browserify,
process, punycode, querystring-es3, stream-browserify, stream-http,
string_decoder, timers-browserify, tty-browserify, url, util, and vm-browserify.
These packages are MIT-licensed.

The complete upstream Bun 1.4.0 notice is available at
<https://github.com/oven-sh/bun/blob/bun-v1.4.0/LICENSE.md>.

## Companion (`smolmux-zmx`)

The release also ships `smolmux-zmx`, the companion daemon that owns each agent's
terminal: a build of the zmx fork at `possibilities/zmx` (the commit is
pinned in `companion.json`), which statically links libghostty-vt and, through
it, uucode with Unicode Character Database data, simdutf, Highway, and Wuffs. The
notices below are those sources' own, as of the pinned commit and its
dependencies; whoever moves the pin re-checks them.

### zmx

Copyright (c) 2025 Eric Bower

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### Ghostty (libghostty-vt)

MIT License

Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### uucode

MIT License

Copyright (c) 2026 Jacob Sandlund

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

uucode's UTF-8 decoder is based on Bjoern Hoehrmann's:

Copyright (c) 2008-2009 Bjoern Hoehrmann <bjoern@hoehrmann.de>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### Unicode Character Database

The Unicode tables compiled into libghostty-vt and uucode are generated from
the Unicode Character Database.

UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2025 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY DOWNLOADING,
INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR SOFTWARE, YOU
UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE TERMS AND CONDITIONS
OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT DOWNLOAD, INSTALL, COPY,
DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a copy of
data files and any associated documentation (the "Data Files") or software and
any associated documentation (the "Software") to deal in the Data Files or
Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, and/or sell copies of the Data Files
or Software, and to permit persons to whom the Data Files or Software are
furnished to do so, provided that either (a) this copyright and permission
notice appear with all copies of the Data Files or Software, or (b) this
copyright and permission notice appear in associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF THIRD
PARTY RIGHTS. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS
NOTICE BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL
DAMAGES, OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING
OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA FILES OR
SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall not be
used in advertising or otherwise to promote the sale, use or other dealings in
these Data Files or Software without prior written authorization of the
copyright holder.

### simdutf

simdutf is available under the Apache License 2.0 or the MIT License; it is
used here under the MIT License.

Copyright 2021 The simdutf authors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### Highway

Highway is available under the Apache License 2.0 or the BSD 3-Clause License;
it is used here under the BSD 3-Clause License.

Copyright (c) The Highway Project Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1.  Redistributions of source code must retain the above copyright notice, this
    list of conditions and the following disclaimer.

2.  Redistributions in binary form must reproduce the above copyright notice,
    this list of conditions and the following disclaimer in the documentation
    and/or other materials provided with the distribution.

3.  Neither the name of the copyright holder nor the names of its
    contributors may be used to endorse or promote products derived from
    this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### Wuffs

Wuffs is available under the Apache License 2.0 or the MIT License; it is
used here under the MIT License.

Copyright 2023 The Wuffs Authors

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
