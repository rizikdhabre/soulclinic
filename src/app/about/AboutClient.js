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
            <h1 className="heading-display text-foreground mb-6">من نحن</h1>
            <p className="text-body text-muted-foreground">
              تأسس مركز العلاج على الإيمان بأن العافية الحقيقية تتحقق من خلال
              التوازن بين الجسد والطاقة، حيث نقدم علاجات متخصصة مثل الحجامة،
              الإبر الجافة، والعلاجات الطبيعية لمساعدة الجسم على الشفاء الذاتي
              وتخفيف الآلام وتحسين جودة الحياة. بخبرة تمتد لأكثر من 3 سنوات
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
              <h2 className="heading-section text-foreground mb-6">مهمتنا</h2>
              <p className="text-body text-muted-foreground mb-6">
                مهمتنا هي تقديم علاجات طبيعية وآمنة تعتمد على أساليب علاجية
                فعّالة مثل الحجامة والإبر الجافة، بهدف تخفيف الألم، تحسين صحة
                الجسم، وتعزيز التوازن الجسدي والنفسي. نلتزم بتوفير رعاية مهنية
                وإنسانية تركّز على احتياجات كل شخص، وتسعى إلى تحقيق شفاء حقيقي
                ومستدام.
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
                    الشفاء بهدف
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
              قيمنا الأساسية
            </h2>
            <p className="text-subtle max-w-2xl mx-auto">
              نؤمن بأن العلاج الحقيقي يقوم على الصدق، الاحترافية، والاهتمام
              بالإنسان قبل كل شيء. ترتكز قيمنا الأساسية على تقديم رعاية آمنة
              وموثوقة، احترام خصوصية كل مراجع، والالتزام بأعلى معايير الجودة.
              نسعى لبناء علاقة ثقة دائمة مع من نخدمهم، ونعمل بروح المسؤولية
              لنكون جزءًا حقيقيًا من رحلة الشفاء والتواز
            </p>
          </motion.div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              {
                icon: Heart,
                title: "الرحمة",
                description:
                  "الرحمة تعني تقديم الرعاية والاهتمام الصادق بكل شخص، مع فهم معاناته ودعمه بلطف واحترام في رحلة الشفاء.",
              },
              {
                icon: Award,
                title: "التميّز",
                description:
                  "التميّز يعني الالتزام بأعلى معايير الجودة والاحترافية في تقديم العلاجات لضمان أفضل النتائج الممكنة.",
              },
              {
                icon: Users,
                title: "الشمولية",
                description:
                  "الشمولية تعني احترام الجميع وتقديم الرعاية دون تمييز، مع مراعاة احتياجات كل فرد وخلفيته",
              },
              {
                icon: Clock,
                title: "الحضور",
                description:
                  "الحضور يعني الإصغاء الكامل والاهتمام الحقيقي بكل شخص، والتواجد الذهني والإنساني أثناء تقديم الرعاية والعلاج.",
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
              تعرّف على فريقنا
            </h2>
            <p className="text-body text-muted-foreground mb-8">
              صقر هو مؤسس المركز وصاحب خبرة معتمدة، حاصل على شهادات مهنية في
              مجاله، ويحرص على تقديم علاج باحترام واهتمام لكل شخص، مع سجل مميّز
              من رضا العملاء، وأسلوب إنساني راقٍ في التعامل والعلاج.
            </p>
          </motion.div>
        </div>
      </section>
    </div>
  );
};

export default About;
