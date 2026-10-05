import { Sidebar, MobileSidebar } from "@/components/dashboard/Sidebar";
import { Topbar } from "@/components/dashboard/Topbar";

export default function MainLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <div className="h-screen bg-background text-foreground flex overflow-hidden">

            {/* Desktop Sidebar (Collapsible) */}
            <Sidebar />

            {/* Mobile drawer (opened by the Topbar hamburger) */}
            <MobileSidebar />

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col overflow-hidden relative z-10">
                <Topbar />

                <main className="flex-1 overflow-y-auto p-4 md:p-8 lg:p-10 scroll-smooth">
                    {children}
                </main>
            </div>
        </div>
    );
}
