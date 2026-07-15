# My App Hub

This repository contains the My App Hub static web app deployed to Firebase Hosting.

## Publish updates to Firebase

To publish changes when HTML files are updated in `public/`:

1. Edit one or more files under `public/`, for example:
   - `public/index.html`
   - `public/Eisenhower Matrix TO DO.html`
   - `public/template.html`

2. Save your changes.

3. Commit and push to GitHub:
   ```bash
   cd "C:\Users\LENOVO\my-app-hub"
   git add public/*.html
   git commit -m "Update public html files"
   git push origin main
   ```

4. The GitHub Actions workflow will automatically deploy the updates to Firebase Hosting when a `public/*.html` file changes.

## Manual deployment

If you want to deploy manually from the local machine:

```bash
cd "C:\Users\LENOVO\my-app-hub"
firebase deploy --only hosting --project my-app-hub-69db8
```

## Live site

- https://my-app-hub-69db8.web.app

## Notes

- The workflow is configured to deploy only when HTML files under `public/` change.
- The repo uses a GitHub Actions secret named `FIREBASE_TOKEN` for deployment.
