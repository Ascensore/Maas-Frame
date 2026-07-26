// The one spec that drives the real login and registration forms. Everything
// else signs in over HTTP through the fixture in fixtures.ts.
//
// `anonTest` gives database seeding with an anonymous browser.
import { anonTest as test, expect, E2E_PASSWORD } from './fixtures';

// Registration is rate limited to five requests per hour per IP, and the window
// lives in Postgres. tests/e2e/global-setup.ts empties that table before each
// run, so this file may spend a few of them; keep it to the two below.
const INVITE_CODE = 'test-invite';

test('an anonymous visitor to a protected route lands on the login page', async ({ page }) => {
  await page.goto('/dashboard');

  await expect(page).toHaveURL(/\/login$/);
  // `CardTitle` renders a <div>, not a heading, so there is no role to match.
  await expect(page.getByText('Welcome back')).toBeVisible();
});

test('registration is refused when the invite code is wrong', async ({ page }) => {
  await page.goto('/register');

  await expect(page.getByText('Join OpenFrame to collaborate on video projects')).toBeVisible();

  await page.getByLabel('Invite Code').fill('definitely-not-the-invite-code');
  await page.getByLabel('Full Name').fill('Wrong Code Person');
  await page.getByLabel('Email').fill(`e2e-rejected-${Date.now()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel('Confirm Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Create Account' }).click();

  await expect(page.getByText('Invalid invite code')).toBeVisible();
  await expect(page).toHaveURL(/\/register$/);
});

test('a new account can be registered with the invite code and then signed in', async ({
  page,
  seed,
}) => {
  const email = `e2e-registered-${Date.now()}@example.com`;

  await page.goto('/register');
  await page.getByLabel('Invite Code').fill(INVITE_CODE);
  await page.getByLabel('Full Name').fill('Freshly Registered');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel('Confirm Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Create Account' }).click();

  // SMTP is unset for the app under test, so isEmailVerificationEnabled() is
  // false and the account is auto-verified rather than parked on /verify-email.
  //
  // Deliberately tolerant of extra query parameters rather than anchored with
  // `$`. What the register flow promises is the login page plus `registered=true`;
  // the rest of the query string is not part of that contract. On CI the login
  // page arrives carrying `callbackUrl=%2Fdashboard`, which it derives from its
  // own default in getSafeCallbackUrl(null), and an anchored pattern turned that
  // into a deterministic CI-only failure while passing locally.
  await expect(page).toHaveURL(/\/login\?(?:.*&)?registered=true(?:&|$)/);
  await expect(page.getByText('Account created successfully!')).toBeVisible();

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // /settings, not /onboarding, and that is the real product behaviour rather
  // than a test artefact: POST /api/auth/register does not set `trialEndsAt`, so
  // with OPENFRAME_ENABLE_STRIPE on a brand new account has no billing access,
  // and requireBillingAccessOrRedirect() on /dashboard sends it to billing
  // before it ever sees the onboarding wizard.
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

  // The Seed fixture only tracks rows it created itself, so remove this one by
  // hand rather than leaving it behind for the next run.
  await seed.deleteUserByEmail(email);
});

test('signing in with the wrong password is refused', async ({ page, seed }) => {
  const user = await seed.user();

  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email ?? '');
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText('Invalid email or password')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('signing in through the form reaches the dashboard, and signing out returns to login', async ({
  page,
  seed,
}) => {
  const user = await seed.user();

  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email ?? '');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();

  await page.goto('/signout');
  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(page).toHaveURL(/\/login$/);

  // The session really is gone, not just navigated away from.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
});
