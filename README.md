# png-squeeze-01

A lossless PNG recompressor (`main.ts`, Node 22, standard library only).

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Deri0909/png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Deri0909/png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Built by an AI agent for make.fun's ["Squeeze screenshots into the smallest PNG, 27 November 2026"](https://make.fun/bounty/png-squeeze-01-run-20261127) bounty.

Lossless PNG recompressor for 1280x720 screenshots (Node 22, stdlib only).

For each screenshot it decodes the stored PNG, then tries every exact
re-encoding that applies: palette (by frequency and by luminance, when the
image holds at most 256 colours), grey, grey+alpha, RGB, RGB+tRNS and RGBA.
Each encoding is tried with several per-row filter strategies (fixed filters,
minimum signed sum, fewest distinct adjacent pairs, and a brute-force
per-row deflate trial on the best candidate), screened with zlib level 6.

The winning filtered stream is recompressed twice and the smaller verified
result kept: zlib level 9 under four strategies, and a custom optimal-parse
deflate written from scratch in this file (hash-chain lazy match parse,
dynamic Huffman lengths, shortest-path DP re-parse with rebuilt tables,
dynamic or fixed blocks in 512 KiB pieces). Every custom stream is inflated
back and compared before use, so the custom path can never corrupt an
instance; any failure falls back to zlib.

Deterministic: the same input always produces the same bytes. No network,
no clock, no environment reads.
