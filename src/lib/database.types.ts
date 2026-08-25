export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      budgets: {
        Row: {
          amount_minor: number
          category_id: string | null
          created_at: string
          id: string
          period_start: string
          wallet_id: string
        }
        Insert: {
          amount_minor: number
          category_id?: string | null
          created_at?: string
          id?: string
          period_start: string
          wallet_id: string
        }
        Update: {
          amount_minor?: number
          category_id?: string | null
          created_at?: string
          id?: string
          period_start?: string
          wallet_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "budgets_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budgets_category_same_wallet"
            columns: ["category_id", "wallet_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id", "wallet_id"]
          },
          {
            foreignKeyName: "budgets_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["id"]
          },
        ]
      }
      categories: {
        Row: {
          archived_at: string | null
          color_slot: number
          created_at: string
          icon: string
          id: string
          is_default: boolean
          kind: Database["public"]["Enums"]["category_kind"]
          name: string
          sort_order: number
          wallet_id: string
        }
        Insert: {
          archived_at?: string | null
          color_slot: number
          created_at?: string
          icon: string
          id?: string
          is_default?: boolean
          kind: Database["public"]["Enums"]["category_kind"]
          name: string
          sort_order?: number
          wallet_id: string
        }
        Update: {
          archived_at?: string | null
          color_slot?: number
          created_at?: string
          icon?: string
          id?: string
          is_default?: boolean
          kind?: Database["public"]["Enums"]["category_kind"]
          name?: string
          sort_order?: number
          wallet_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "categories_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["id"]
          },
        ]
      }
      currencies: {
        Row: {
          code: string
          minor_unit: number
          name: string
          symbol: string
        }
        Insert: {
          code: string
          minor_unit: number
          name: string
          symbol: string
        }
        Update: {
          code?: string
          minor_unit?: number
          name?: string
          symbol?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          base_currency: string
          created_at: string
          display_name: string | null
          id: string
          theme: Database["public"]["Enums"]["theme_pref"]
        }
        Insert: {
          base_currency?: string
          created_at?: string
          display_name?: string | null
          id: string
          theme?: Database["public"]["Enums"]["theme_pref"]
        }
        Update: {
          base_currency?: string
          created_at?: string
          display_name?: string | null
          id?: string
          theme?: Database["public"]["Enums"]["theme_pref"]
        }
        Relationships: [
          {
            foreignKeyName: "profiles_base_currency_fkey"
            columns: ["base_currency"]
            isOneToOne: false
            referencedRelation: "currencies"
            referencedColumns: ["code"]
          },
        ]
      }
      transactions: {
        Row: {
          amount_minor: number
          category_id: string | null
          created_at: string
          created_by: string | null
          currency_code: string
          deleted_at: string | null
          id: string
          kind: Database["public"]["Enums"]["txn_kind"]
          note: string | null
          occurred_on: string
          transfer_id: string | null
          updated_at: string
          wallet_id: string
        }
        Insert: {
          amount_minor: number
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          currency_code: string
          deleted_at?: string | null
          id?: string
          kind: Database["public"]["Enums"]["txn_kind"]
          note?: string | null
          occurred_on: string
          transfer_id?: string | null
          updated_at?: string
          wallet_id: string
        }
        Update: {
          amount_minor?: number
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string
          deleted_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["txn_kind"]
          note?: string | null
          occurred_on?: string
          transfer_id?: string | null
          updated_at?: string
          wallet_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transactions_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_category_same_wallet"
            columns: ["category_id", "wallet_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id", "wallet_id"]
          },
          {
            foreignKeyName: "transactions_currency_code_fkey"
            columns: ["currency_code"]
            isOneToOne: false
            referencedRelation: "currencies"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "transactions_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["id"]
          },
        ]
      }
      wallet_invites: {
        Row: {
          created_at: string
          id: string
          invited_by: string
          invited_email: string
          responded_at: string | null
          status: Database["public"]["Enums"]["invite_status"]
          wallet_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          invited_by: string
          invited_email: string
          responded_at?: string | null
          status?: Database["public"]["Enums"]["invite_status"]
          wallet_id: string
        }
        Update: {
          created_at?: string
          id?: string
          invited_by?: string
          invited_email?: string
          responded_at?: string | null
          status?: Database["public"]["Enums"]["invite_status"]
          wallet_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wallet_invites_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["id"]
          },
        ]
      }
      wallet_members: {
        Row: {
          joined_at: string
          role: Database["public"]["Enums"]["member_role"]
          user_id: string
          wallet_id: string
        }
        Insert: {
          joined_at?: string
          role?: Database["public"]["Enums"]["member_role"]
          user_id: string
          wallet_id: string
        }
        Update: {
          joined_at?: string
          role?: Database["public"]["Enums"]["member_role"]
          user_id?: string
          wallet_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wallet_members_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["id"]
          },
        ]
      }
      wallets: {
        Row: {
          archived_at: string | null
          color_slot: number
          created_at: string
          currency_code: string
          icon: string
          id: string
          kind: Database["public"]["Enums"]["wallet_kind"]
          name: string
          owner_id: string
          starting_balance_minor: number
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          color_slot: number
          created_at?: string
          currency_code: string
          icon: string
          id?: string
          kind: Database["public"]["Enums"]["wallet_kind"]
          name: string
          owner_id: string
          starting_balance_minor?: number
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          color_slot?: number
          created_at?: string
          currency_code?: string
          icon?: string
          id?: string
          kind?: Database["public"]["Enums"]["wallet_kind"]
          name?: string
          owner_id?: string
          starting_balance_minor?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "wallets_currency_code_fkey"
            columns: ["currency_code"]
            isOneToOne: false
            referencedRelation: "currencies"
            referencedColumns: ["code"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_wallet_invite: { Args: { invite: string }; Returns: undefined }
      create_transfer: {
        Args: {
          amount_in: number
          amount_out: number
          from_wallet: string
          note?: string
          on_date: string
          to_wallet: string
        }
        Returns: string
      }
      decline_wallet_invite: { Args: { invite: string }; Returns: undefined }
      get_budget_status: {
        Args: { from_date: string; to_date: string }
        Returns: {
          budget_id: string
          budget_minor: number
          budget_period_start: string
          category_id: string
          category_name: string
          color_slot: number
          currency_code: string
          icon: string
          spent_minor: number
          wallet_id: string
          wallet_name: string
        }[]
      }
      get_cash_flow: {
        Args: {
          bucket?: string
          from_date: string
          to_date: string
          wallet_ids: string[]
        }
        Returns: {
          bucket_start: string
          in_minor: number
          out_minor: number
        }[]
      }
      get_category_breakdown: {
        Args: { from_date: string; to_date: string; wallet_ids: string[] }
        Returns: {
          category_id: string
          color_slot: number
          icon: string
          name: string
          total_minor: number
        }[]
      }
      get_pending_invites: {
        Args: never
        Returns: {
          created_at: string
          id: string
          wallet_id: string
          wallet_name: string
        }[]
      }
      get_wallet_balances: {
        Args: never
        Returns: {
          balance_minor: number
          currency_code: string
          wallet_id: string
        }[]
      }
      get_wallet_members: {
        Args: never
        Returns: {
          display_name: string
          role: Database["public"]["Enums"]["member_role"]
          user_id: string
          wallet_id: string
        }[]
      }
      is_wallet_member: { Args: { w: string }; Returns: boolean }
      set_budget: {
        Args: {
          p_amount_minor: number
          p_category_id: string
          p_period_start: string
          p_wallet_id: string
        }
        Returns: string
      }
    }
    Enums: {
      category_kind: "expense" | "income"
      invite_status: "pending" | "accepted" | "declined"
      member_role: "owner" | "member"
      theme_pref: "system" | "light" | "dark"
      txn_kind: "expense" | "income" | "transfer"
      wallet_kind: "card" | "bank"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      category_kind: ["expense", "income"],
      invite_status: ["pending", "accepted", "declined"],
      member_role: ["owner", "member"],
      theme_pref: ["system", "light", "dark"],
      txn_kind: ["expense", "income", "transfer"],
      wallet_kind: ["card", "bank"],
    },
  },
} as const

