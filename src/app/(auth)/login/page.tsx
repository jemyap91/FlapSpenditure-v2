import { LoginForm } from "./login-form";

/**
 * Server Component so `?error=auth` (set by src/app/auth/callback/route.ts
 * when a code exchange fails) can be read via the `searchParams` prop
 * without needing `useSearchParams` + a Suspense boundary in the client
 * form — see node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md,
 * "Server Components > Pages": "To access search params in Pages (Server
 * Components), use the searchParams prop."
 */
export default async function LoginPage(props: PageProps<"/login">) {
  const searchParams = await props.searchParams;
  const notice =
    searchParams.error === "auth"
      ? "That sign-in link is invalid or has expired. Please sign in with your email and password."
      : undefined;

  return <LoginForm notice={notice} />;
}
