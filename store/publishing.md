# Publishing to the Chrome Web Store from GitHub

The release workflow (`.github/workflows/release.yml`) has a job `store`. When you push a version tag, the job uploads the new version to the Chrome Web
Store item and submits the version for review. When Google approves the version, the store publishes it.

The job uses no stored password or key. GitHub gives the job a short identity token. Google exchanges that token for a one-hour access token of a
service account. The Web Store dashboard lets that service account publish your items.

The job does nothing until the four repository variables in step 4 exist.

## What the API cannot do

The Chrome Web Store API can only upload and submit a new version of an item that exists. Do these tasks in the Developer Dashboard:

- Create the item.
- Change the store listing, the privacy fields or the screenshots.
- Change the visibility. If you change the visibility, publish one version manually. Then the API can publish again.

## Setup

Do this setup one time. You need the Google account that owns the Web Store item, with 2-step verification on.

1. Open https://console.cloud.google.com/ and create a project, for example `textcache-publishing`. Write down the project ID.
2. Open Cloud Shell (the terminal icon at the top of the console). Cloud Shell has the `gcloud` command.
3. In Cloud Shell, run these commands. Replace `PROJECT_ID` with your project ID:

   ```bash
   PROJECT_ID=PROJECT_ID
   gcloud services enable chromewebstore.googleapis.com iamcredentials.googleapis.com sts.googleapis.com iam.googleapis.com --project "$PROJECT_ID"
   gcloud iam service-accounts create textcache-publisher --project "$PROJECT_ID" --display-name "TextCache publisher"
   gcloud iam workload-identity-pools create github --project "$PROJECT_ID" --location global --display-name "GitHub Actions"
   gcloud iam workload-identity-pools providers create-oidc textcache --project "$PROJECT_ID" --location global \
     --workload-identity-pool github --display-name "navara/textcache" --issuer-uri "https://token.actions.githubusercontent.com" \
     --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
     --attribute-condition "assertion.repository == 'navara/textcache'"
   POOL=$(gcloud iam workload-identity-pools describe github --project "$PROJECT_ID" --location global --format "value(name)")
   gcloud iam service-accounts add-iam-policy-binding "textcache-publisher@$PROJECT_ID.iam.gserviceaccount.com" --project "$PROJECT_ID" \
     --role roles/iam.workloadIdentityUser --member "principalSet://iam.googleapis.com/$POOL/attribute.repository/navara/textcache"
   gcloud iam workload-identity-pools providers describe textcache --project "$PROJECT_ID" --location global --workload-identity-pool github \
     --format "value(name)"
   ```

   The last command shows the provider name. The name starts with `projects/` and contains the project number. Write down the name.
   If the first command cannot find `chromewebstore.googleapis.com`, open "APIs & Services", search for "Chrome Web Store API" and enable it there.

4. Open https://chrome.google.com/webstore/devconsole and do these steps:
   1. In the Account section, add the service account email `textcache-publisher@PROJECT_ID.iam.gserviceaccount.com`.
   2. In "Publisher > Settings", find the publisher ID. Write down the publisher ID.
5. Set these repository variables in GitHub (Settings > Secrets and variables > Actions > Variables):

   | Variable | Value |
   | --- | --- |
   | `GCP_WORKLOAD_IDENTITY_PROVIDER` | the provider name from step 3 |
   | `GCP_SERVICE_ACCOUNT` | `textcache-publisher@PROJECT_ID.iam.gserviceaccount.com` |
   | `CWS_PUBLISHER_ID` | the publisher ID from step 4 |
   | `CWS_ITEM_ID` | `nlcmfgfjlbenaojmhnepjklepcinpfda` |

6. Wait 5 minutes. Google can need this time before the new identity settings work.
7. In GitHub, open Actions > Release and click "Run workflow". The job `store` shows the item status in the step "Item status before". This run does not
   change the store.

## Release

1. Increase `version` in `extension/manifest.json`. The store refuses a version that is not higher than the last uploaded version.
2. Push a tag `v<version>`, for example `v1.2`.
3. Look at the job `store` in Actions. The step "Submit for review" shows the new state, normally `PENDING_REVIEW`.

If the item has a version in review, the store can refuse a new upload. In that case, wait for the review to end, or cancel the review in the
dashboard. Then run the failed job again.
