# Vendored engine

Upstream: https://github.com/estebancitox/lab-cdt-ladder
Upstream path: src/engine/
Commit: 6444d05df4385343d5593b94d9e5822cad647e10
Vendored: 2026-09-26

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
| format.test.ts | 6c670abf24e5cb0c54270010687c45b7a0d76d9e2ee297a8a49d3fc6fb38503e |
| format.ts | fffdc0ab9a5f0d4d11e4254e56af9335523a94b9c75a92aa3d1d8b3d0982acda |
| index.ts | 60d174afe5e6f2ffe963ba72790941eff7a89199071287e2adec7da77683059a |
| money.test.ts | f86cb05be010ebf56f07beb09b98f619d6827a6bc53fabcca252214cf872cae2 |
| money.ts | 3697fc73078db9961bdad15cae09b481de0b17920122786e062e9e711a05697e |
| rates.test.ts | 1c183e1062b931891950ae7ee5a44dccfa7a87bd40b6199b679c412741d863e1 |
| rates.ts | e0be8f668e8707dbb7c8b49cf7921afd89c254b2d2f9df284c8cdf4e8388796a |
| rollover.test.ts | d908ff974a5c2d166f36d7d3c147a4b40a31b69d9b91a2496c9582c8ec435b5f |
| rollover.ts | 1ecc2f41867c3c4d9da53a6d0be1fc3a1e99505e84c5283e7729ae7abf5fcb0c |
| scenario.test.ts | a5f366d38628608104fb39caa96d74a3a4841b3577cca9e4fe81d904bba53f79 |
| scenario.ts | 460ef8aa102ae82d02720e43c501a8e908f11534166abfbe28310121f9f80d4c |
| types.ts | d4ff8b31ab04fe74d3b299989c9f07449445e9df50e37465b3716102c010bf8e |
| validate.test.ts | 906a03b679cefd82e80546a4641a0f26daef03f32c3779f24a5a27e15f2c1331 |
| validate.ts | f7abff49f9f50e78575cc6a3be6fbc535ce4e738cad9c1bbf388c5259318730b |
