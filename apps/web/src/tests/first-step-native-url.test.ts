import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFirstStepUrl } from '../shared/first-step-discovery.js';
function ref(url: string) { const result = classifyFirstStepUrl(url); assert.ok(result.ok); return result.ref; }
test('Instagram and Threads retain their different real profile path conventions', () => {
  const instagram = ref('https://www.instagram.com/fixture_lin/');
  assert.equal(instagram.accountUrl, 'https://www.instagram.com/fixture_lin');
  assert.equal(instagram.profileUrl, instagram.accountUrl);
  assert.equal(ref('https://www.threads.net/@fixture_lin').accountUrl, 'https://www.threads.net/@fixture_lin');
  assert.equal(ref('https://www.instagram.com/p/fixture-post/').entry, 'page');
});
test('Facebook numeric native IDs stay distinct and only profile.php binds that identity', () => {
  const one = ref('https://www.facebook.com/profile.php?id=10000123&ref=share');
  const two = ref('https://www.facebook.com/profile.php?id=10000456');
  assert.equal(one.accountUrl, 'https://www.facebook.com/profile.php?id=10000123');
  assert.equal(one.profileUrl, one.accountUrl);
  assert.equal(one.entry, 'profile');
  assert.notEqual(one.accountKey, two.accountKey);
  assert.equal(ref('https://www.facebook.com/photo.php?id=10000123').entry, 'page');
  assert.equal(ref('https://www.facebook.com/profile.php?id=invalid').entry, 'page');
});


test('publication platform landing pages and tracking parameters never become an author account', () => {
  for (const url of ['https://substack.com/', 'https://substack.com/?utm_content=synthetic-author', 'https://medium.com/', 'https://medium.com/topics/science']) {
    const classified = ref(url);
    assert.equal(classified.entry, 'page');
    assert.equal(classified.attributable, false);
    assert.equal(classified.handle, null);
  }
  assert.equal(ref('https://substack.com/@synthetic-author').entry, 'profile');
  assert.equal(ref('https://medium.com/@synthetic-author').entry, 'profile');
});
