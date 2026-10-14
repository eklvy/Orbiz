import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <Link href="/" className="mt-4 inline-block text-primary underline">
        Back to outlets
      </Link>
    </div>
  );
}
