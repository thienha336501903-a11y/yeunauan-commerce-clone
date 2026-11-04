// Commerce -> lms calls (H5 route mode). A Worker on a route cannot be reached by URL from another Worker in the
// same zone (the request goes to the origin instead), so the commerce Worker registers its LMS service binding here.
// Without a binding (Vercel, tests, Custom Domain setups) this is plain fetch, exactly as before.
let binding = null;

export function setLmsBinding(service) {
  binding = service && typeof service.fetch === "function" ? service : null;
}

export function lmsFetch(url, init) {
  return binding ? binding.fetch(url, init) : fetch(url, init);
}
