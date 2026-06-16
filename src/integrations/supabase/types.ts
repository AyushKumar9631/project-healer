export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      appointment_whatsapp_logs: {
        Row: {
          call_id: string | null
          created_at: string
          error: string | null
          id: string
          message_sid: string | null
          phone: string | null
          status: string | null
        }
        Insert: {
          call_id?: string | null
          created_at?: string
          error?: string | null
          id?: string
          message_sid?: string | null
          phone?: string | null
          status?: string | null
        }
        Update: {
          call_id?: string | null
          created_at?: string
          error?: string | null
          id?: string
          message_sid?: string | null
          phone?: string | null
          status?: string | null
        }
        Relationships: []
      }
      appointments: {
        Row: {
          appointment_date: string
          appointment_time: string
          call_id: string
          clinic_id: string
          created_at: string
          doctor_id: string
          id: string
          notes: string | null
          patient_id: string
          status: string
          updated_at: string
        }
        Insert: {
          appointment_date: string
          appointment_time: string
          call_id: string
          clinic_id: string
          created_at?: string
          doctor_id: string
          id?: string
          notes?: string | null
          patient_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          appointment_date?: string
          appointment_time?: string
          call_id?: string
          clinic_id?: string
          created_at?: string
          doctor_id?: string
          id?: string
          notes?: string | null
          patient_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointments_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: true
            referencedRelation: "calls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      babies: {
        Row: {
          baby_name: string
          clinic_id: string
          created_at: string
          dob: string
          gender: string | null
          id: string
          notes: string | null
          parent_name: string
          patient_id: string
          updated_at: string
        }
        Insert: {
          baby_name: string
          clinic_id: string
          created_at?: string
          dob: string
          gender?: string | null
          id?: string
          notes?: string | null
          parent_name: string
          patient_id: string
          updated_at?: string
        }
        Update: {
          baby_name?: string
          clinic_id?: string
          created_at?: string
          dob?: string
          gender?: string | null
          id?: string
          notes?: string | null
          parent_name?: string
          patient_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "babies_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      call_events: {
        Row: {
          call_id: string
          clinic_id: string
          created_at: string
          event_type: string
          id: string
          payload: Json | null
        }
        Insert: {
          call_id: string
          clinic_id: string
          created_at?: string
          event_type: string
          id?: string
          payload?: Json | null
        }
        Update: {
          call_id?: string
          clinic_id?: string
          created_at?: string
          event_type?: string
          id?: string
          payload?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "call_events_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_events_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      call_outcomes: {
        Row: {
          call_id: string
          clinic_id: string
          config_snapshot: Json | null
          created_at: string
          playbook_key: string
          red_flag: boolean
          structured: Json
          success: boolean
        }
        Insert: {
          call_id: string
          clinic_id: string
          config_snapshot?: Json | null
          created_at?: string
          playbook_key: string
          red_flag?: boolean
          structured?: Json
          success?: boolean
        }
        Update: {
          call_id?: string
          clinic_id?: string
          config_snapshot?: Json | null
          created_at?: string
          playbook_key?: string
          red_flag?: boolean
          structured?: Json
          success?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "call_outcomes_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: true
            referencedRelation: "calls"
            referencedColumns: ["id"]
          },
        ]
      }
      call_timings: {
        Row: {
          call_id: string
          clinic_id: string
          created_at: string
          detail: Json
          direction: string
          duration_ms: number | null
          id: string
          occurred_at: string
          phase: string
          provider: string
          t_offset_ms: number
        }
        Insert: {
          call_id: string
          clinic_id: string
          created_at?: string
          detail?: Json
          direction: string
          duration_ms?: number | null
          id?: string
          occurred_at?: string
          phase: string
          provider: string
          t_offset_ms: number
        }
        Update: {
          call_id?: string
          clinic_id?: string
          created_at?: string
          detail?: Json
          direction?: string
          duration_ms?: number | null
          id?: string
          occurred_at?: string
          phase?: string
          provider?: string
          t_offset_ms?: number
        }
        Relationships: []
      }
      calls: {
        Row: {
          appointment_time: string | null
          callback_requested: boolean
          callback_time: string | null
          campaign_id: string | null
          clinic_id: string
          condition_mentioned: string | null
          created_at: string
          direction: string
          duration_seconds: number | null
          ended_at: string | null
          id: string
          intent: string | null
          notes: string | null
          opening_greeting_audio_url: string | null
          opening_greeting_error: string | null
          opening_greeting_ready_at: string | null
          opening_greeting_text: string | null
          outcome: Json | null
          patient_id: string
          phone_number: string | null
          plivo_call_uuid: string | null
          provider: string | null
          recording_duration_seconds: number | null
          recording_id: string | null
          recording_ready_at: string | null
          recording_url: string | null
          simulated: boolean
          started_at: string | null
          status: string
          suggested_doctor_id: string | null
          transcript: Json
          twilio_call_sid: string | null
          updated_at: string
        }
        Insert: {
          appointment_time?: string | null
          callback_requested?: boolean
          callback_time?: string | null
          campaign_id?: string | null
          clinic_id: string
          condition_mentioned?: string | null
          created_at?: string
          direction?: string
          duration_seconds?: number | null
          ended_at?: string | null
          id?: string
          intent?: string | null
          notes?: string | null
          opening_greeting_audio_url?: string | null
          opening_greeting_error?: string | null
          opening_greeting_ready_at?: string | null
          opening_greeting_text?: string | null
          outcome?: Json | null
          patient_id: string
          phone_number?: string | null
          plivo_call_uuid?: string | null
          provider?: string | null
          recording_duration_seconds?: number | null
          recording_id?: string | null
          recording_ready_at?: string | null
          recording_url?: string | null
          simulated?: boolean
          started_at?: string | null
          status?: string
          suggested_doctor_id?: string | null
          transcript?: Json
          twilio_call_sid?: string | null
          updated_at?: string
        }
        Update: {
          appointment_time?: string | null
          callback_requested?: boolean
          callback_time?: string | null
          campaign_id?: string | null
          clinic_id?: string
          condition_mentioned?: string | null
          created_at?: string
          direction?: string
          duration_seconds?: number | null
          ended_at?: string | null
          id?: string
          intent?: string | null
          notes?: string | null
          opening_greeting_audio_url?: string | null
          opening_greeting_error?: string | null
          opening_greeting_ready_at?: string | null
          opening_greeting_text?: string | null
          outcome?: Json | null
          patient_id?: string
          phone_number?: string | null
          plivo_call_uuid?: string | null
          provider?: string | null
          recording_duration_seconds?: number | null
          recording_id?: string | null
          recording_ready_at?: string | null
          recording_url?: string | null
          simulated?: boolean
          started_at?: string | null
          status?: string
          suggested_doctor_id?: string | null
          transcript?: Json
          twilio_call_sid?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "calls_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_suggested_doctor_id_fkey"
            columns: ["suggested_doctor_id"]
            isOneToOne: false
            referencedRelation: "doctors"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_call_queue: {
        Row: {
          call_id: string | null
          campaign_id: string
          clinic_id: string
          completed_at: string | null
          created_at: string
          id: string
          last_error: string | null
          outcome: string | null
          patient_id: string
          phone_number: string | null
          retry_count: number
          scheduled_at: string | null
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          call_id?: string | null
          campaign_id: string
          clinic_id: string
          completed_at?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          outcome?: string | null
          patient_id: string
          phone_number?: string | null
          retry_count?: number
          scheduled_at?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          call_id?: string | null
          campaign_id?: string
          clinic_id?: string
          completed_at?: string | null
          created_at?: string
          id?: string
          last_error?: string | null
          outcome?: string | null
          patient_id?: string
          phone_number?: string | null
          retry_count?: number
          scheduled_at?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      campaign_playbook_config: {
        Row: {
          campaign_id: string
          clinic_id: string
          config_json: Json
          created_at: string
          playbook_key: string
          updated_at: string
        }
        Insert: {
          campaign_id: string
          clinic_id: string
          config_json?: Json
          created_at?: string
          playbook_key: string
          updated_at?: string
        }
        Update: {
          campaign_id?: string
          clinic_id?: string
          config_json?: Json
          created_at?: string
          playbook_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_playbook_config_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: true
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          clinic_id: string
          completed_at: string | null
          completed_calls: number
          created_at: string
          id: string
          name: string
          patient_list_id: string | null
          scheduled_at: string | null
          started_at: string | null
          status: string
          total_patients: number
          updated_at: string
          use_case: string
        }
        Insert: {
          clinic_id: string
          completed_at?: string | null
          completed_calls?: number
          created_at?: string
          id?: string
          name: string
          patient_list_id?: string | null
          scheduled_at?: string | null
          started_at?: string | null
          status?: string
          total_patients?: number
          updated_at?: string
          use_case?: string
        }
        Update: {
          clinic_id?: string
          completed_at?: string | null
          completed_calls?: number
          created_at?: string
          id?: string
          name?: string
          patient_list_id?: string | null
          scheduled_at?: string | null
          started_at?: string | null
          status?: string
          total_patients?: number
          updated_at?: string
          use_case?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_patient_list_id_fkey"
            columns: ["patient_list_id"]
            isOneToOne: false
            referencedRelation: "patient_lists"
            referencedColumns: ["id"]
          },
        ]
      }
      clinic_profile: {
        Row: {
          about: string | null
          accreditations: string[]
          address: string | null
          clinic_id: string
          created_at: string
          departments: string[]
          emergency_phone: string | null
          extra_notes: string | null
          timings: string | null
          updated_at: string
        }
        Insert: {
          about?: string | null
          accreditations?: string[]
          address?: string | null
          clinic_id: string
          created_at?: string
          departments?: string[]
          emergency_phone?: string | null
          extra_notes?: string | null
          timings?: string | null
          updated_at?: string
        }
        Update: {
          about?: string | null
          accreditations?: string[]
          address?: string | null
          clinic_id?: string
          created_at?: string
          departments?: string[]
          emergency_phone?: string | null
          extra_notes?: string | null
          timings?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      clinics: {
        Row: {
          created_at: string
          email: string | null
          id: string
          name: string
          owner_id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          name: string
          owner_id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          owner_id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      doctors: {
        Row: {
          availability: string | null
          clinic_id: string
          conditions: string[]
          consultation_fee: number | null
          created_at: string
          experience_years: number | null
          id: string
          languages: string[]
          name: string
          online_consultation: boolean
          patients_treated: number | null
          qualifications: string | null
          specialization: string | null
          super_specialization: string | null
          updated_at: string
        }
        Insert: {
          availability?: string | null
          clinic_id: string
          conditions?: string[]
          consultation_fee?: number | null
          created_at?: string
          experience_years?: number | null
          id?: string
          languages?: string[]
          name: string
          online_consultation?: boolean
          patients_treated?: number | null
          qualifications?: string | null
          specialization?: string | null
          super_specialization?: string | null
          updated_at?: string
        }
        Update: {
          availability?: string | null
          clinic_id?: string
          conditions?: string[]
          consultation_fee?: number | null
          created_at?: string
          experience_years?: number | null
          id?: string
          languages?: string[]
          name?: string
          online_consultation?: boolean
          patients_treated?: number | null
          qualifications?: string | null
          specialization?: string | null
          super_specialization?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "doctors_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_faqs: {
        Row: {
          answer: string
          clinic_id: string
          created_at: string
          id: string
          is_active: boolean
          question: string
          tags: string[]
          updated_at: string
        }
        Insert: {
          answer: string
          clinic_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          question: string
          tags?: string[]
          updated_at?: string
        }
        Update: {
          answer?: string
          clinic_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          question?: string
          tags?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      kb_policies: {
        Row: {
          clinic_id: string
          created_at: string
          id: string
          is_active: boolean
          priority: number
          rule: string
          title: string
          updated_at: string
        }
        Insert: {
          clinic_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          priority?: number
          rule: string
          title: string
          updated_at?: string
        }
        Update: {
          clinic_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          priority?: number
          rule?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      kb_services: {
        Row: {
          category: string | null
          clinic_id: string
          created_at: string
          currency: string
          description: string | null
          duration_minutes: number | null
          id: string
          is_active: boolean
          name: string
          prep_notes: string | null
          price_max: number | null
          price_min: number | null
          updated_at: string
        }
        Insert: {
          category?: string | null
          clinic_id: string
          created_at?: string
          currency?: string
          description?: string | null
          duration_minutes?: number | null
          id?: string
          is_active?: boolean
          name: string
          prep_notes?: string | null
          price_max?: number | null
          price_min?: number | null
          updated_at?: string
        }
        Update: {
          category?: string | null
          clinic_id?: string
          created_at?: string
          currency?: string
          description?: string | null
          duration_minutes?: number | null
          id?: string
          is_active?: boolean
          name?: string
          prep_notes?: string | null
          price_max?: number | null
          price_min?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      patient_lists: {
        Row: {
          clinic_id: string
          created_at: string
          id: string
          name: string
          patient_count: number
          source: string | null
          updated_at: string
        }
        Insert: {
          clinic_id: string
          created_at?: string
          id?: string
          name: string
          patient_count?: number
          source?: string | null
          updated_at?: string
        }
        Update: {
          clinic_id?: string
          created_at?: string
          id?: string
          name?: string
          patient_count?: number
          source?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_lists_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      patients: {
        Row: {
          age: number | null
          blood_sugar: string | null
          bp: string | null
          clinic_id: string
          created_at: string
          gender: string | null
          health_camp: string | null
          id: string
          name: string
          patient_list_id: string | null
          phone: string
          risk: string | null
          updated_at: string
        }
        Insert: {
          age?: number | null
          blood_sugar?: string | null
          bp?: string | null
          clinic_id: string
          created_at?: string
          gender?: string | null
          health_camp?: string | null
          id?: string
          name: string
          patient_list_id?: string | null
          phone: string
          risk?: string | null
          updated_at?: string
        }
        Update: {
          age?: number | null
          blood_sugar?: string | null
          bp?: string | null
          clinic_id?: string
          created_at?: string
          gender?: string | null
          health_camp?: string | null
          id?: string
          name?: string
          patient_list_id?: string | null
          phone?: string
          risk?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "patients_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patients_patient_list_id_fkey"
            columns: ["patient_list_id"]
            isOneToOne: false
            referencedRelation: "patient_lists"
            referencedColumns: ["id"]
          },
        ]
      }
      vaccination_doses: {
        Row: {
          age_milestone: string
          baby_id: string
          clinic_id: string
          created_at: string
          done_at: string | null
          due_date: string
          id: string
          last_call_id: string | null
          reminded_count: number
          rescheduled_to: string | null
          status: string
          updated_at: string
          vaccine_code: string
        }
        Insert: {
          age_milestone: string
          baby_id: string
          clinic_id: string
          created_at?: string
          done_at?: string | null
          due_date: string
          id?: string
          last_call_id?: string | null
          reminded_count?: number
          rescheduled_to?: string | null
          status?: string
          updated_at?: string
          vaccine_code: string
        }
        Update: {
          age_milestone?: string
          baby_id?: string
          clinic_id?: string
          created_at?: string
          done_at?: string | null
          due_date?: string
          id?: string
          last_call_id?: string | null
          reminded_count?: number
          rescheduled_to?: string | null
          status?: string
          updated_at?: string
          vaccine_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "vaccination_doses_baby_id_fkey"
            columns: ["baby_id"]
            isOneToOne: false
            referencedRelation: "babies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      call_billable_seconds: {
        Args: { c: Database["public"]["Tables"]["calls"]["Row"] }
        Returns: number
      }
      current_clinic_id: { Args: never; Returns: string }
    }
    Enums: {
      [_ in never]: never
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
  public: {
    Enums: {},
  },
} as const
