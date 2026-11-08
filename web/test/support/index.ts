// web/test/support: what component tests share (README.md next to this file). The session and media fakes are not
// re-exported here: a test that mocks those modules imports ./support/session or ./support/media itself, from its
// vi.mock factory and for mockSession()/mockMedia().
export { onCleanup, afterEveryTest } from "./cleanup";
export { installCanvas, canvasCalls } from "./canvas";
export { installMediaElements } from "./mediaElements";
export { renderUI, resetStore, baseState, person, roster, ME, LOOK, type UIResult } from "./render";
export { stubFetch, offlineFetch, unhandledRejections, type FetchStub, type StubRequest, type StubReply, type Route } from "./fetch";
export { stubMediaDevices, fakeDevice, fakeTrack, fakeStream, stubIdleDetector, stubKeyboardLayout, type MediaDevicesFake, type IdleDetectorFake, type FakeTrack } from "./navigator";
