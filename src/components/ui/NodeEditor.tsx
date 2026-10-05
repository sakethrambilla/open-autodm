"use client";

import { motion, useMotionValue, useMotionTemplate, useTransform } from "framer-motion";
import { Workflow, Calendar, BarChart, Send, Layers } from "lucide-react";
import { useEffect, useState, useRef } from "react";

// Helper component to dry up the animated connecting lines
function AnimatedConnection({
    startX, startY, endX, endY, color
}: { startX: any, startY: any, endX: any, endY: any, color: string }) {

    // Calculate horizontal midpoint for the bezier control points (Classic n8n S-Curve)
    const midX = useTransform([startX, endX], ([s, e]: any) => (s + e) / 2);

    // Create the precise S-curve path string dynamically
    const path = useMotionTemplate`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;

    return (
        <motion.path
            d={path}
            stroke={color}
            strokeWidth="1.5"
            strokeDasharray="5 6"
            fill="none"
            className="animate-[flowDots_1.4s_linear_infinite]"
        />
    );
}

export function NodeEditor() {
    const [mounted, setMounted] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Motion values for the Center node ("AutoDM Hub") - fully draggable
    const cx = useMotionValue(-150);
    const cy = useMotionValue(0);

    // Motion values for peripheral nodes - branching to the right like n8n
    const dmX = useMotionValue(80);
    const dmY = useMotionValue(-80);

    const contentX = useMotionValue(250);
    const contentY = useMotionValue(-80);

    const linksX = useMotionValue(80);
    const linksY = useMotionValue(90);

    const analyticsX = useMotionValue(250);
    const analyticsY = useMotionValue(90);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) {
        return <div className="w-full h-full min-h-[300px]" />;
    }

    return (
        <div ref={containerRef} className="relative w-full h-full min-h-[350px] flex items-center justify-center pointer-events-auto bg-transparent z-10">

            {/*
        This wrapper perfectly aligns the SVG's 0,0 origin to the center of the viewport,
        ensuring 1:1 sync with Framer's center-origin coordinate matrix.
        Giving it 1x1 size prevents WebKit/Blink from culling the SVG entirely.
      */}
            <div className="absolute inset-0 pointer-events-none z-0 flex items-center justify-center">
                <svg
                    className="overflow-visible"
                    style={{ width: "1px", height: "1px" }}
                >
                    <style dangerouslySetInnerHTML={{
                        __html: `
            @keyframes flowDots {
              from { stroke-dashoffset: 11; }
              to { stroke-dashoffset: 0; }
            }
          `}} />

                    <AnimatedConnection startX={cx} startY={cy} endX={dmX} endY={dmY} color="var(--foreground)" />
                    <AnimatedConnection startX={cx} startY={cy} endX={contentX} endY={contentY} color="var(--foreground)" />
                    <AnimatedConnection startX={cx} startY={cy} endX={linksX} endY={linksY} color="var(--foreground)" />
                    <AnimatedConnection startX={cx} startY={cy} endX={analyticsX} endY={analyticsY} color="var(--foreground)" />
                </svg>
            </div>

            {/* Core Node - Draggable */}
            <motion.div
                drag
                dragMomentum={false}
                dragElastic={0}
                dragConstraints={{ left: -1000, right: 1000, top: -1000, bottom: 1000 }}
                style={{ x: cx, y: cy }}
                className="absolute z-20 flex items-center gap-2.5 pointer-events-auto px-4 py-3.5 rounded-md cursor-grab active:cursor-grabbing bg-foreground text-background"
            >
                <Workflow className="w-4 h-4 sm:w-5 sm:h-5" />
                <span className="font-heading font-bold text-[13px] sm:text-[15px] tracking-tight">AutoDM hub</span>
            </motion.div>

            {/* Peripheral Nodes - Draggable */}
            <motion.div
                drag
                dragMomentum={false}
                dragElastic={0}
                dragConstraints={{ left: -1000, right: 1000, top: -1000, bottom: 1000 }}
                style={{ x: dmX, y: dmY }}
                className="absolute z-10 pointer-events-auto flex items-center gap-2 px-3 py-2 sm:px-3.5 sm:py-2.5 bg-lilac text-lilac-ink border border-foreground/80 rounded-md cursor-grab active:cursor-grabbing"
            >
                <Send className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                <span className="font-semibold text-[12px] sm:text-[13px] text-foreground">DM auto</span>
            </motion.div>

            <motion.div
                drag
                dragMomentum={false}
                dragElastic={0}
                dragConstraints={{ left: -1000, right: 1000, top: -1000, bottom: 1000 }}
                style={{ x: contentX, y: contentY }}
                className="absolute z-10 pointer-events-auto flex items-center gap-2 px-3 py-2 sm:px-3.5 sm:py-2.5 bg-peach text-peach-ink border border-foreground/80 rounded-md cursor-grab active:cursor-grabbing"
            >
                <Calendar className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                <span className="font-semibold text-[12px] sm:text-[13px] text-foreground">Content</span>
            </motion.div>

            <motion.div
                drag
                dragMomentum={false}
                dragElastic={0}
                dragConstraints={{ left: -1000, right: 1000, top: -1000, bottom: 1000 }}
                style={{ x: linksX, y: linksY }}
                className="absolute z-10 pointer-events-auto flex items-center gap-2 px-3 py-2 sm:px-3.5 sm:py-2.5 bg-sage text-sage-ink border border-foreground/80 rounded-md cursor-grab active:cursor-grabbing"
            >
                <Layers className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                <span className="font-semibold text-[12px] sm:text-[13px] text-foreground">Links</span>
            </motion.div>

            <motion.div
                drag
                dragMomentum={false}
                dragElastic={0}
                dragConstraints={{ left: -1000, right: 1000, top: -1000, bottom: 1000 }}
                style={{ x: analyticsX, y: analyticsY }}
                className="absolute z-10 pointer-events-auto flex items-center gap-2 px-3 py-2 sm:px-3.5 sm:py-2.5 bg-mist text-mist-ink border border-foreground/80 rounded-md cursor-grab active:cursor-grabbing"
            >
                <BarChart className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                <span className="font-semibold text-[12px] sm:text-[13px] text-foreground">Analytics</span>
            </motion.div>

            {/* Hint Text */}
            <div className="absolute bottom-2 right-4 text-[12px] text-muted-foreground pointer-events-none">
                Drag any node
            </div>
        </div>
    );
}
