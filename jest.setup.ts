// Hermetic test env: platform tooling and split-deployment setups export
// NEXT_PUBLIC_API_BASE_URL into the host shell; api-base reads it at module
// load, which would flip api-base tests into "split mode" assertions. Force
// same-origin mode before any test module is imported.
delete process.env.NEXT_PUBLIC_API_BASE_URL;
