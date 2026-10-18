import NextAuth, { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { getServiceRoleClient } from "@/lib/supabase";

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET || "fallback-secret-for-development-only",
  session: {
    strategy: "jwt",
  },
  // 기본 제공 화면(/api/auth/signin·/api/auth/error)은 스킨이 없다. 둘 다 우리 /login 으로.
  // error 는 ?error=코드 로 넘어오고 LoginCard 가 한 줄로 풀어 쓴다.
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      if (!user.email) return false;

      const supabase = getServiceRoleClient();

      // Upsert user in public.users table
      const { error } = await supabase
        .from("users")
        .upsert(
          {
            email: user.email,
            name: user.name || null,
            image: user.image || null,
          },
          { onConflict: "email" }
        );

      if (error) {
        console.error("Failed to upsert user:", error);
        return false;
      }

      return true;
    },

    async jwt({ token, user }) {
      if (user?.email) {
        // Fetch Supabase user ID by email
        const supabase = getServiceRoleClient();
        const { data } = await supabase
          .from("users")
          .select("id")
          .eq("email", user.email)
          .single();

        if (data) {
          token.sub = data.id;
        }
      }
      return token;
    },

    async session({ session, token }) {
      if (session.user && token?.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
};

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
