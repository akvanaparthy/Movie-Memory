"use client";

import Image from "next/image";
import { useState } from "react";

type ProfileUser = {
  name: string | null;
  email: string;
  image: string | null;
};

/**
 * Who is signed in. Google does not always supply a name or a photo, so both
 * are optional: the email stands in for a missing name, and an initial stands
 * in for a missing (or broken) photo.
 */
export function Profile({ user }: { user: ProfileUser }) {
  const name = user.name?.trim() || null;
  const heading = name ?? user.email;

  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar src={user.image} initial={heading.charAt(0).toUpperCase()} />
      <div className="min-w-0">
        <p className="truncate font-medium">{heading}</p>
        {name && <p className="truncate text-sm text-haze">{user.email}</p>}
      </div>
    </div>
  );
}

function Avatar({ src, initial }: { src: string | null; initial: string }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-full bg-white/10 text-sm font-medium"
      >
        {initial}
      </span>
    );
  }

  return (
    <Image
      src={src}
      // Decorative: the name sits right beside it.
      alt=""
      width={40}
      height={40}
      className="size-10 shrink-0 rounded-full"
      onError={() => setFailed(true)}
    />
  );
}
