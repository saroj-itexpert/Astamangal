# Ashtamangal Kosh portal

This is a multi-user web portal built with Vite and Supabase. Supabase Auth handles sign-in; PostgreSQL row-level security protects member records; security-definer database functions perform authorized financial postings in a single transaction. Browser storage is not used for accounts or financial records.

## Database and security setup

1. Create a Supabase project and keep its database password and service-role key private.
2. Open **SQL Editor** in the Supabase dashboard and run [`supabase/schema.sql`](./supabase/schema.sql).
3. In **Authentication → URL Configuration**, add the local development URL (for example `http://localhost:5173`) and the eventual production URL to the allowed redirect URLs.
4. Keep public sign-ups disabled. Invite each member from **Authentication → Users → Invite user**. Include `full_name` in the user's metadata if available; the database trigger creates a member profile automatically. The member then receives the Supabase invitation link and sets their own password.
5. Invite the first board administrator in the same way. After that user accepts the invitation and their profile exists, promote the account in SQL Editor:

   ```sql
   update public.profiles
   set role = 'admin'
   where email = 'board-admin@example.com';
   ```

   Do this only for approved board members. The web application cannot promote accounts or change roles. Add other board admins using the same controlled SQL operation.
6. In **Project Settings → API**, copy the project URL and the **publishable/anon public key**. Never use the `service_role` key in the browser or commit it to the project.
7. Copy `.env.example` to `.env` and fill in those two public values.
8. From the project folder run `npm install`, then `npm run dev`, and open the URL Vite prints (usually `http://localhost:5173`). Do not open `index.html` with VS Code Live Server: it does not bundle the app's Supabase module or provide Vite environment variables. Use `npm run build` for a production build.
9. Sign in as an administrator and set each member's loan limit under **Member accounts**, then select **Save**. Limits are entered manually by the board; recorded deposits do not automatically increase them. Invite additional members in Supabase Auth; they appear in the portal after their profile is created.

## Deploy to Vercel for testing

1. Make sure the project builds locally with `npm run build`. Keep `.env` out of Git; it is ignored by `.gitignore`.
2. Push this project to a GitHub repository. This workspace may not yet be a Git repository; use GitHub Desktop or initialize and push the project with Git. Do not upload `.env`, a Supabase secret/service-role key, or real member data.
3. In Vercel, choose **Add New → Project**, import the GitHub repository, and use these settings:
   - Framework preset: **Vite**
   - Build command: `npm run build`
   - Output directory: `dist`
   - Install command: `npm install` (default)
4. In the Vercel project configuration, add these environment variables for **Production** and, if using preview deployments, **Preview**:
   - `VITE_SUPABASE_URL` = your Supabase Project URL, such as `https://your-project-ref.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = your Supabase publishable key or legacy anon key

   These `VITE_` values are sent to the browser by design. Never add a Supabase secret/service-role key.
5. Deploy, then copy the Vercel production URL (for example `https://your-project.vercel.app`).
6. In Supabase, open **Authentication → URL Configuration**. Set **Site URL** to the production Vercel URL, and add that exact URL to **Redirect URLs**. If testing a Vercel preview deployment, add its exact preview URL too. Save the settings.
7. If environment variables were added or changed after deployment, trigger a new Vercel deployment so Vite rebuilds with them.
8. Open the Vercel URL in a private/incognito browser window and test with invited test accounts. Public sign-up is disabled; users must be invited in Supabase Auth. Confirm member accounts cannot see other members' records and that the board account can perform only expected actions.

Share the production Vercel URL with testers. They sign in with the email/password set through their Supabase invitation. Use a separate test Supabase project and test data for a trial; do not use real Kosh records or funds until the ledger, policies, backups, and operational procedures have been reviewed.

## Operational flow

- Members sign in, review their own balances and latest transactions, and submit loan applications. A member can have only one pending application, and the database enforces the configured limit against their combined active principal.
- Board members review requests. Approval checks the member limit and available recorded cash while holding a database lock, creates the loan, posts the disbursement, records the audit event, and notifies the member atomically. Rejection requires a reason.
- An administrator posts deposits or repayments. Repayments use database-calculated simple daily interest and support interest-first or principal-first allocation. A payment larger than the calculated balance is rejected.
- Members see in-app notifications on their portal after they sign in or refresh. The application does not send email/SMS notifications.
- Financial transactions and audit entries cannot be updated or deleted through the application/database grants. Correct errors with a separately designed and approved reversal/adjustment workflow; do not edit historical records.

## Important notes before using real funds

- This replacement does not automatically migrate records from the previous browser-only app. Preserve and reconcile its backup separately before switching; do not treat the new portal's initially empty ledger as a carry-over of old balances.
- The schema uses a fixed 12% annual interest rate for newly approved loans and simple daily accrual on the outstanding principal. Confirm the Kosh's actual bylaws and legally applicable requirements before changing this policy or relying on balances.
- Member loan limits are configured by the board and apply to combined active principal; the application does not infer eligibility from deposits or contributions.
- The dashboard shows estimated interest between postings; the database is authoritative when a repayment is posted.
- Cash balance is calculated from posted deposits and repayments minus disbursements. Add a separate, reviewed ledger workflow before recording expenses, opening balances, historical transactions, or corrections.
- This is an application starter, not an independent financial audit or legal review. Test in a non-production Supabase project, verify backups and access recovery, and reconcile imported balances before onboarding real members.
- There is no offline posting: financial changes require a live authenticated connection and a successful server response.

## Access-control model

The browser receives only the Supabase public key. It has no financial write access to the ledger tables. RLS allows a member to select only their profile, applications, loans, transactions, and notifications. A board admin can read the Kosh-wide records. Privileged writes are limited to database functions that verify the caller's role and validate amounts, membership, balances, and status transitions. Never expose the Supabase service-role key in this application.
