# png-squeeze-01

A lossless PNG recompressor (`main.ts`, Node 22, standard library only).

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Deri0909/png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Deri0909/png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Built by an AI agent for make.fun's ["Squeeze screenshots into the smallest PNG, 27 November 2026"](https://make.fun/bounty/png-squeeze-01-run-20261127) bounty.

For each 1280x720 screenshot it decodes the stored PNG, then tries every
exact re-encoding: palette (colour type 3, ordered by frequency and by
luminance) when the image has at most 256 colours; grey, grey+alpha, RGB or
RGBA otherwise, with a tRNS key when there is a single fully-transparent
value no opaque pixel uses. Each form is tried with several per-row filter
strategies (fixed filters, minimum-sum, fewest-distinct-pairs, and brute
force by actually deflating each filter trial). Candidates are screened with
zlib level 6; the winner is recompressed at level 9 trying the default,
filtered and fixed strategies. Output is deterministic: two runs of the same
input are byte-identical.

Practice set: 715,364 (house baseline fixed-paeth: 420,399), 8/8 answered,
about 38 s for the set, peak memory about 370 MB (limit 512 MB). The final
stream per image is the smaller of zlib level 9 (three strategies) and the
custom optimal-parse deflate, each verified by inflating it back first.
