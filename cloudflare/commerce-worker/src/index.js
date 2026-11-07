// SYSTEM B commerce Worker entry (H1). All logic is in app.js; the entry module may export only handlers
// and Durable Object classes.
import { handleRequest } from "./app.js";
export { MessengerConversation } from "./messenger.js";

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx)
};
