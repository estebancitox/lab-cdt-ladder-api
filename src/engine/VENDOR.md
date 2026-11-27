# Vendored engine

Upstream: https://github.com/estebancitox/lab-cdt-ladder
Upstream path: src/engine/
Commit: 6e23cdd6ef1e02611fc82e908d7c6df1095641ce
Vendored: 2026-11-26

The 18 files below were extracted from the commit object with `git archive`, never from
the working tree, and are never edited, not even for formatting or lint (SPEC §9). This
directory holds the 10 production files and the 8 test files that SPEC §9 counts, plus
this record; nothing else may live here.

Verification: `npm run verify:vendor` re-derives every hash from the pinned commit in the
sibling checkout at `../lab-cdt-ladder` and compares blob ids as well; `src/vendor.test.ts`
re-hashes the files on disk against this table on every test run and needs no sibling.

| File | SHA-256 |
|---|---|
| dates.test.ts | 281c923ee1af04f0c7e37edcf1f67621476d92b8c63d86ae6faed84ec8701c7a |
| dates.ts | c24d7ad892464dfb788e24afac1322c736d5e90b9b429c7afe70f9b2ac18d091 |
| exposure.test.ts | da1ee6853dc748d44b5fb560de5d38f1629e1ae5023740b6b1864969239765e1 |
| exposure.ts | 7437bcb3da33aff250d50b9fee0dc4dea131e64d2f382d9965ef2623ad1f58b6 |
| format.test.ts | 0c2b7619642e8259983e66cc1c453fe018e74eee2d9290f3930dacf7b49c34f7 |
| format.ts | 542969eb4c42fa50871822d8444f8616e1f3af58b1441a3a20f5fd48ea37a922 |
| index.ts | e8f437cf32e5e41f2e2b90b1be7ab215b67a6ab6f7e59e392aac750b4c9d9944 |
| money.test.ts | f86cb05be010ebf56f07beb09b98f619d6827a6bc53fabcca252214cf872cae2 |
| money.ts | 3697fc73078db9961bdad15cae09b481de0b17920122786e062e9e711a05697e |
| rates.test.ts | 1c183e1062b931891950ae7ee5a44dccfa7a87bd40b6199b679c412741d863e1 |
| rates.ts | e0be8f668e8707dbb7c8b49cf7921afd89c254b2d2f9df284c8cdf4e8388796a |
| rollover.test.ts | d908ff974a5c2d166f36d7d3c147a4b40a31b69d9b91a2496c9582c8ec435b5f |
| rollover.ts | 329dd1f378499aede7a12a894d4502e62c6861ae16bb83a1aa26596ff9915607 |
| scenario.test.ts | a5f366d38628608104fb39caa96d74a3a4841b3577cca9e4fe81d904bba53f79 |
| scenario.ts | 9b720a64edad594d6f2cd5e39e4e76b9f5e4e9e11a421f113a0dd6990c2dd228 |
| types.ts | 51f21c3a14667c6b066a695ca46f283ac3e097e584ce74ff1fdc5d66b3a4232c |
| validate.test.ts | d15d88ea3e87191e6e0dfc8f26fa4734dfe1e4c8716a896620183e4a1ebb3ce0 |
| validate.ts | d4c2f758b1c7de733736fa805a659ecc3607e9d7ed2216979d7d652a9b0935ef |
