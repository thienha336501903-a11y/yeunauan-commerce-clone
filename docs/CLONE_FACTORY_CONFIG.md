# Commerce Clone Factory configuration

Commerce shares one codebase across cloned systems. Runtime identity and service
origins are read through `utils/clone-config.js`; handlers and pages must not
embed deployment-specific domains.

System B remains the compatibility default when the new variables are absent.
`SYSTEM3_URL` and `SYSTEM1_URL` remain accepted as legacy aliases so the current
Production deployment keeps its existing behavior.

The existing `/api/config?runtime=1` function exposes only safe public values and
does not create an additional Vercel Serverless Function.

Run `npm test` and `npm run check:clone` before deploying a clone.
