// /settings — one page, one implementation.
//
// The route used to carry its own older settings screen while a newer one sat
// unused in components/settings-new (never imported — so the app kept showing
// the old UI). The screen now lives in components/settings/settings-page and
// this file is only the route entry, which keeps `tab` deep links and legacy
// tab ids (profile/api/cost/danger/keyboard) working through the page's own
// LEGACY map.
export { default } from "@/components/settings/settings-page";
