# Third-party notices

`@daas/toolbox` contains code copied or ported from the open-source projects below. Keep this
file with the code wherever it is copied, and ship it with any SDK build that includes that code.
The MIT license requires the copyright and permission notices to accompany every copy.

Code not listed here, including `src/deeplink/` and `src/hooks/useDeeplinkHandler/`, is original
to this package and is not covered by these notices.

## ahooks

- Source: https://github.com/alibaba/hooks, version 3.11.0
  (upstream commit `43003f3bd5e6921173cfa2a791ed9d34e5221935`)
- License: MIT
- Files:
  - `src/hooks/createUpdateEffect/`
  - `src/hooks/useCreation/`
  - `src/hooks/useHistoryTravel/`
  - `src/hooks/useLatest/`
  - `src/hooks/useMemoizedFn/`
  - `src/hooks/useMount/`
  - `src/hooks/usePrevious/`
  - `src/hooks/useRequest/`
  - `src/hooks/useUnmount/`
  - `src/hooks/useUpdate/`
  - `src/hooks/useUpdateEffect/`
  - `src/hooks/useWhyDidYouUpdate/`
  - `src/utils/depsAreSame.ts`, `src/utils/index.ts`, `src/utils/isBrowser.ts`,
    `src/utils/isDev.ts`, `src/utils/testingHelpers.ts`
- Modifications: the lodash `debounce`/`throttle` dependency is replaced with `src/utils/debounce.ts`;
  import paths are adjusted for the new layout; code is reformatted; `isDev.ts` declares `process`
  locally and guards against it being undefined, so it works without Node types or a bundler.

```text
MIT License

Copyright (c) 2019-present ahooks

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
```

## lodash

- Source: https://github.com/lodash/lodash, version 4.17.21
- License: MIT
- Files: `src/utils/debounce.ts`, a TypeScript port of `debounce` and `throttle` covering
  `leading`, `trailing`, `maxWait`, `cancel` and `flush`.

```text
Copyright OpenJS Foundation and other contributors <https://openjsf.org/>

Based on Underscore.js, copyright Jeremy Ashkenas,
DocumentCloud and Investigative Reporters & Editors <http://underscorejs.org/>

This software consists of voluntary contributions made by many
individuals. For exact contribution history, see the revision history
available at https://github.com/lodash/lodash

The following license applies to all parts of this software except as
documented below:

====

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

====

Copyright and related rights for sample code are waived via CC0. Sample
code is defined as all source code displayed within the prose of the
documentation.

CC0: http://creativecommons.org/publicdomain/zero/1.0/

====

Files located in the node_modules and vendor directories are externally
maintained libraries used by this software which have their own
licenses; we recommend you read them, as their terms may differ from the
terms above.
```
