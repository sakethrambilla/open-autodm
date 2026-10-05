"use client";

import { motion } from "framer-motion";
import { LoginForm } from "@/components/auth/LoginForm";
import { NodeEditor } from "@/components/ui/NodeEditor";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { LogoMark, LogoWordmark } from "@/components/ui/Logo";

export default function LoginPage() {
  return (
    <div className="h-screen w-screen flex flex-col p-4 sm:p-8 md:p-12 font-sans relative overflow-hidden text-foreground bg-background">

      <div className="absolute top-6 right-6 lg:top-8 lg:right-8 z-50 flex items-center">
        <ThemeToggle />
      </div>

      {/* Header Logo Row */}
      <div className="relative z-10 flex items-center space-x-3 mb-2 mx-auto lg:mx-0 lg:ml-12 w-full max-w-[90rem]">
        <LogoMark className="w-9 h-9" />
        <LogoWordmark className="text-xl" />
      </div>

      {/* Main Container */}
      <div className="flex flex-col lg:flex-row gap-6 w-full max-w-[90rem] z-10 mx-auto flex-1 min-h-0 items-center justify-between">

        {/* Left Area - headline + interactive nodes */}
        <div className="hidden lg:flex relative flex-col justify-center items-start flex-1 w-full lg:w-[55%] h-full lg:pl-16 pt-2 lg:pt-8 pointer-events-none">

          <div className="relative z-10 flex flex-col w-full max-w-2xl shrink-0 text-left mt-2 lg:mt-4 pointer-events-auto">
            <motion.h1
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="text-5xl lg:text-[64px] font-heading font-extrabold leading-[0.98] tracking-[-0.035em] mb-6"
            >
              Comment-to-DM automation you host yourself.
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.1 }}
              className="text-base lg:text-[17px] text-muted-foreground max-w-[34rem] mb-2 leading-relaxed"
            >
              Automate Instagram comment replies and DMs through your own Meta app, on your own
              infrastructure. Free, open source, and built to respect every Instagram API rule.
            </motion.p>
          </div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.25 }}
            className="w-full relative z-50 flex-1 min-h-[350px] flex items-center justify-center lg:justify-start mt-4 pointer-events-auto"
          >
            <NodeEditor />
          </motion.div>

        </div>

        {/* Right Area - auth form */}
        <div className="flex w-full lg:w-1/2 max-w-[460px] flex-col justify-center items-center lg:items-end relative h-full shrink-0 lg:pr-12 pointer-events-none">

          <div className="relative z-30 w-full flex justify-end pointer-events-auto">
            <LoginForm />
          </div>
        </div>

      </div>

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 text-[12px] text-muted-foreground whitespace-nowrap">
        MIT licensed, self-hosted and free
      </div>
    </div>
  );
}
