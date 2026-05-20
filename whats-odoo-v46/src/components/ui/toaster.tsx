"use client"

import { Toaster as SonnerToaster } from "sonner"

function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      richColors
      closeButton
      duration={4000}
    />
  )
}

export { Toaster }
