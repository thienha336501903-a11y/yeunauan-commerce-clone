// SYSTEM B commerce Worker entry (H1). All logic is in app.js; the entry module may export only handlers.
import { handleRequest } from "./app.js";

export default {
  fetch: (request, env) => handleRequest(request, env)
};
