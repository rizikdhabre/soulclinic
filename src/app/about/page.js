"use client";

import { motion } from "framer-motion";
import { Award, Users, Clock, Heart } from "lucide-react";

const About = () => {
  return (
    <div className="min-h-screen pt-24">
      {/* Hero Section */}
      <section className="py-20 wellness-gradient">
        <div className="container mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7 }}
            className="max-w-3xl mx-auto text-center"
          >
            <h1 className="heading-display text-foreground mb-6">
              Our Story
            </h1>
            <p className="text-body text-muted-foreground">
              Founded on the belief that true wellness encompasses mind, body,
              and spirit, Serenity has been a sanctuary of healing for over a
              decade.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Mission Section */}
      <section className="py-24 bg-background">
        <div className="container mx-auto px-6">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <motion.div
              initial={{ opacity: 0, x: -30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6 }}
            >
              <h2 className="heading-section text-foreground mb-6">
                Our Mission
              </h2>
              <p className="text-body text-muted-foreground mb-6">
                At Serenity, we believe everyone deserves access to transformative
                wellness experiences. Our mission is to create a space where
                ancient healing traditions meet modern comfort, providing
                personalized care that addresses your unique needs.
              </p>
              <p className="text-body text-muted-foreground">
                Every treatment is crafted with intention, every product is
                thoughtfully sourced, and every interaction is guided by our
                commitment to your wellbeing.
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="relative"
            >
              <div className="aspect-[4/3] rounded-3xl overflow-hidden bg-wellness-sage-light/30 flex items-center justify-center">
                <div className="text-center p-8">
                  <Heart className="w-16 h-16 text-primary mx-auto mb-4" />
                  <p className="font-serif text-2xl text-foreground">
                    Healing with Purpose
                  </p>
                </div>
              </div>

              {/* Decorative Element */}
              <motion.div
                animate={{ y: [-5, 5, -5] }}
                transition={{ duration: 4, repeat: Infinity }}
                className="absolute -bottom-6 -left-6 w-24 h-24 rounded-full bg-accent/20 blur-xl"
              />
            </motion.div>
          </div>
        </div>
      </section>

      {/* Values Section */}
      <section className="py-24 bg-card">
        <div className="container mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="text-center mb-16"
          >
            <h2 className="heading-section text-foreground mb-4">
              Our Core Values
            </h2>
            <p className="text-subtle max-w-2xl mx-auto">
              These principles guide everything we do, from the treatments we
              offer to the environment we create.
            </p>
          </motion.div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              {
                icon: Heart,
                title: "Compassion",
                description: "Every guest is treated with genuine care and empathy.",
              },
              {
                icon: Award,
                title: "Excellence",
                description: "We maintain the highest standards in all our practices.",
              },
              {
                icon: Users,
                title: "Inclusivity",
                description: "Wellness is for everyone, without exception.",
              },
              {
                icon: Clock,
                title: "Presence",
                description: "We honor your time and remain fully present.",
              },
            ].map((value, index) => (
              <motion.div
                key={value.title}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="glass-card p-6 text-center"
              >
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                  <value.icon className="w-6 h-6 text-primary" />
                </div>
                <h3 className="font-serif text-xl text-foreground mb-2">
                  {value.title}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {value.description}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Team Section */}
      <section className="py-24 bg-background">
        <div className="container mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="max-w-3xl mx-auto text-center"
          >
            <h2 className="heading-section text-foreground mb-6">
              Meet Our Team
            </h2>
            <p className="text-body text-muted-foreground mb-8">
              Our therapists are more than practitioners—they're healers who bring
              decades of combined experience, continuous learning, and a genuine
              passion for wellness to every session.
            </p>
            <p className="text-subtle">
              Each team member is certified in their specialty and committed to
              ongoing education in the latest wellness techniques and research.
            </p>
          </motion.div>
        </div>
      </section>
    </div>
  );
};

export default About;
